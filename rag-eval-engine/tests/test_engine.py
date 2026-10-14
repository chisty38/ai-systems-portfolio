import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
import pandas as pd
from model_client import ModelClient, score_reply
from retrieval import retrieve, average_precision, LexicalRetriever
from synth_generator import SyntheticDatasetGenerator
from eval_harness import RagEvaluationHarness, summarize, validate_dataset, write_report
from pathlib import Path
import tempfile


class FakeClock:
    def __init__(self):
        self.now, self.delays = 0.0, []

    def clock(self):
        return self.now

    def sleep(self, delay):
        self.delays.append(delay)
        self.now += delay


def reply(value):
    return SimpleNamespace(text=json.dumps(value))


class EngineTests(unittest.TestCase):
    def test_duplicate_text_retains_distinct_document_ids(self):
        index = LexicalRetriever(['Warranty repairs.', 'Warranty repairs.'])
        self.assertEqual(index.retrieve_ids('warranty', 2), [0, 1])
        labels = [i in {1} for i in index.retrieve_ids('warranty', 2)]
        self.assertEqual(average_precision(labels), .5)

    def test_stable_ties_and_top_k_larger_than_corpus(self):
        self.assertEqual(LexicalRetriever(['first', 'second']).retrieve_ids('unmatched', 10), [0, 1])

    def test_dataset_rejects_invalid_and_duplicate_labels(self):
        for ids in [[True], [-1], [2], [0, 0]]:
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                validate_dataset({'documents': ['doc'], 'cases': [
                    {'question': 'question', 'ground_truth': 'answer', 'relevant_document_ids': ids}]})

    def test_prompt_budget_rejects_before_request(self):
        model = self.model([])
        model.max_prompt_chars = 5
        with self.assertRaisesRegex(ValueError, 'max_prompt_chars'):
            model.call('a very long prompt')
        self.sdk.models.generate_content.assert_not_called()

    def test_sdk_configuration_error_is_not_retried(self):
        model = self.model([ValueError('bad SDK configuration')], 2)
        with self.assertRaisesRegex(RuntimeError, 'after 1 tries'):
            model.call('prompt')
        self.sdk.models.generate_content.assert_called_once()

    def test_context_budget_records_failure_without_request(self):
        model = self.model([])
        result = RagEvaluationHarness(model, max_context_chars=2).run_benchmark(pd.DataFrame([
            {'question': 'q', 'ground_truth': 'a', 'contexts': ['long context']}]))
        self.assertEqual(result.iloc[0]['status'], 'error')
        self.sdk.models.generate_content.assert_not_called()

    def test_failure_aware_summary(self):
        rows = [{'status': 'ok', 'faithfulness': .8, 'context_sufficiency': 1, 'context_precision': .5},
                {'status': 'error', 'faithfulness': None, 'context_sufficiency': None, 'context_precision': None}]
        summary = summarize(rows)
        self.assertEqual(summary['completed_rows'], 1)
        self.assertEqual(summary['failed_rows'], 1)
        self.assertEqual(summary['mean_scores_completed_only']['faithfulness'], .8)
        self.assertIsNone(summarize([rows[1]])['mean_scores_completed_only']['faithfulness'])

    def test_each_finished_row_is_checkpointed(self):
        model = self.model([TimeoutError('network')])
        checkpoint = Mock()
        RagEvaluationHarness(model).run_benchmark(pd.DataFrame([
            {'question': 'q', 'ground_truth': 'a', 'contexts': ['context']}]), on_result=checkpoint)
        self.assertEqual(checkpoint.call_args.args[0]['status'], 'error')

    def test_report_replace_leaves_valid_json(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'report.json'
            write_report(path, {'run_status': 'running'})
            write_report(path, {'run_status': 'complete'})
            self.assertEqual(json.loads(path.read_text())['run_status'], 'complete')
            self.assertFalse(path.with_suffix('.json.tmp').exists())

    def model(self, replies, max_retries=0, rpm=60):
        self.timer = FakeClock()
        self.sdk = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(side_effect=replies)))
        return ModelClient(self.sdk, max_retries=max_retries, requests_per_minute=rpm,
                           sleep=self.timer.sleep, clock=self.timer.clock)

    def test_invalid_scores(self):
        for score in [45, -1, 1.01, '0.9', None, True, float('nan'), float('inf')]:
            with self.subTest(score=score), self.assertRaises(ValueError):
                score_reply({'score': score})

    def test_threshold_endpoints(self):
        self.assertEqual(score_reply({'score': 0}), 0)
        self.assertEqual(score_reply({'score': 1}), 1)

    def test_malformed_replies_retry(self):
        model = self.model([SimpleNamespace(text=''), SimpleNamespace(text='{bad'), reply({'score': .8})], 2)
        self.assertEqual(model.call('judge', score_reply), .8)
        self.assertEqual(self.sdk.models.generate_content.call_count, 3)
        self.assertEqual(self.timer.delays, [1, 2])

    def test_transient_error_recovers(self):
        model = self.model([ConnectionError('network'), reply({'score': .8})], 1)
        self.assertEqual(model.call('judge', score_reply), .8)

    def test_429_recovers(self):
        error = RuntimeError('quota')
        error.code = 429
        model = self.model([error, reply({'score': .8})], 1)
        self.assertEqual(model.call('judge', score_reply), .8)

    def test_authentication_error_is_not_retried(self):
        error = RuntimeError('unauthorized')
        error.code = 401
        model = self.model([error], 2)
        with self.assertRaisesRegex(RuntimeError, 'after 1 tries'):
            model.call('judge', score_reply)
        self.assertEqual(self.sdk.models.generate_content.call_count, 1)

    def test_retry_exhaustion(self):
        model = self.model([TimeoutError('network')] * 3, 2)
        with self.assertRaisesRegex(RuntimeError, 'after 3 tries'):
            model.call('judge', score_reply)

    def test_shared_rate_limit(self):
        model = self.model([SimpleNamespace(text='first'), SimpleNamespace(text='second')], rpm=5)
        model.call('one')
        model.call('two')
        self.assertEqual(self.timer.delays, [12])

    def test_invalid_options(self):
        for options in [{'max_retries': -1}, {'max_retries': True}, {'retry_delay': float('nan')},
                        {'requests_per_minute': 0}, {'requests_per_minute': float('inf')}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                ModelClient(client=object(), **options)

    def test_synthetic_schema_and_count(self):
        model = self.model([reply([{'question': 'Warranty?', 'ground_truth': '12 months'}])])
        data = SyntheticDatasetGenerator(model).generate_eval_pairs('Warranty lasts 12 months.', 1)
        self.assertEqual(data.iloc[0]['contexts'], ['Warranty lasts 12 months.'])

    def test_bad_synthetic_pairs_rejected(self):
        for pairs in [[], [{}], [{'question': '', 'ground_truth': 'answer'}]]:
            with self.subTest(pairs=pairs), self.assertRaises(RuntimeError):
                SyntheticDatasetGenerator(self.model([reply(pairs)])).generate_eval_pairs('context', 1)

    def test_empty_input_rejected_without_model_call(self):
        gen = SyntheticDatasetGenerator(self.model([]))
        with self.assertRaises(ValueError):
            gen.generate_eval_pairs('', 1)
        self.sdk.models.generate_content.assert_not_called()

    def test_retrieval_ranks_relevant_chunk_first(self):
        self.assertEqual(retrieve('warranty repairs', ['Cafe coffee.', 'Warranty covers repairs.'], 1),
                         ['Warranty covers repairs.'])

    def test_average_precision_penalizes_noise(self):
        self.assertEqual(average_precision([True, False]), 1)
        self.assertEqual(average_precision([False, True]), .5)
        self.assertAlmostEqual(average_precision([True, False, True]), 5 / 6)
        self.assertEqual(average_precision([False, False]), 0)

    def test_all_contexts_used_and_ranked_metric(self):
        model = self.model([SimpleNamespace(text='answer'), reply({'score': .8}), reply({'score': 1}),
                            reply({'relevant': False}), reply({'relevant': True})])
        data = pd.DataFrame([{'question': 'question', 'ground_truth': 'answer', 'contexts': ['noise', 'useful']}])
        result = RagEvaluationHarness(model).run_benchmark(data)
        self.assertEqual(result.iloc[0]['context_precision'], .5)
        self.assertEqual(result.iloc[0]['status'], 'ok')
        prompt = self.sdk.models.generate_content.call_args_list[0].kwargs['contents']
        self.assertIn('noise\n\nuseful', prompt)

    def test_partial_results_survive_later_failure(self):
        model = self.model([SimpleNamespace(text='answer'), reply({'score': 1}), reply({'score': 1}),
                            reply({'relevant': True}), TimeoutError('network')])
        row = {'question': 'question', 'ground_truth': 'answer', 'contexts': ['useful']}
        result = RagEvaluationHarness(model).run_benchmark(pd.DataFrame([row, row]))
        self.assertEqual(result['status'].tolist(), ['ok', 'error'])
        self.assertEqual(result.iloc[0]['faithfulness'], 1)
        self.assertIn('network', result.iloc[1]['error'])
        self.assertIsNone(json.loads(result.to_json(orient='records'))[1]['faithfulness'])

    def test_empty_benchmark_rejected(self):
        with self.assertRaises(ValueError):
            RagEvaluationHarness(self.model([])).run_benchmark(pd.DataFrame())

    def test_bad_context_records_failure_without_call(self):
        model = self.model([])
        result = RagEvaluationHarness(model).run_benchmark(pd.DataFrame([
            {'question': 'question', 'ground_truth': 'answer', 'contexts': []}]))
        self.assertEqual(result.iloc[0]['status'], 'error')
        self.sdk.models.generate_content.assert_not_called()


if __name__ == '__main__':
    unittest.main()
