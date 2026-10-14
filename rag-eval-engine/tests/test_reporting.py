"""Reporting and CLI contract tests; no credentials or model requests."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

import pandas as pd
from eval_harness import RagEvaluationHarness, main, summarize, write_report


class FakeCaller:
    def call(self, prompt, parser=None):
        return parser({'score': .8, 'relevant': True}) if parser else 'supported answer'


class ReportingTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.dataset = self.root / 'dataset.json'
        self.output = self.root / 'report.json'
        self.dataset.write_text(json.dumps({'documents': ['supported evidence'], 'cases': [
            {'question': 'sensitive question', 'ground_truth': 'answer', 'relevant_document_ids': [0]},
            {'question': 'other sensitive question', 'ground_truth': 'answer', 'relevant_document_ids': [0]}
        ]}), encoding='utf-8')
        self.args = ['--dataset', str(self.dataset), '--output', str(self.output), '--top-k', '1']

    def test_summary_rejects_missing_or_invalid_success_metrics(self):
        for value in [None, True, float('nan'), float('inf'), 45, '0.9']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'faithfulness'):
                summarize([{'status': 'ok', 'faithfulness': value, 'context_sufficiency': 1, 'context_precision': 1}])

    def test_summary_rejects_unknown_status(self):
        with self.assertRaises(ValueError):
            summarize([{'status': 'pending'}])

    def test_failed_serialization_keeps_previous_report(self):
        write_report(self.output, {'version': 1})
        with self.assertRaises(ValueError):
            write_report(self.output, {'score': float('nan')})
        self.assertEqual(json.loads(self.output.read_text()), {'version': 1})

    def test_failed_replace_keeps_previous_report_and_cleans_temp(self):
        write_report(self.output, {'version': 1})
        with patch.object(Path, 'replace', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                write_report(self.output, {'version': 2})
        self.assertEqual(json.loads(self.output.read_text()), {'version': 1})
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_callback_cannot_mutate_harness_results(self):
        def mutate(row):
            row['status'] = 'corrupted'
            row['contexts'].clear()
        frame = pd.DataFrame([{'question': 'q', 'ground_truth': 'a', 'contexts': ['evidence']}])
        report = RagEvaluationHarness(FakeCaller()).run_benchmark(frame, on_result=mutate)
        self.assertEqual(report.iloc[0]['status'], 'ok')
        self.assertEqual(report.iloc[0]['contexts'], ['evidence'])

    def test_callback_storage_failures_propagate(self):
        def fail(row):
            raise OSError('disk error')
        frame = pd.DataFrame([{'question': 'q', 'ground_truth': 'a', 'contexts': ['evidence']}])
        with self.assertRaisesRegex(OSError, 'disk error'):
            RagEvaluationHarness(FakeCaller()).run_benchmark(frame, on_result=fail)

    def test_progress_does_not_pollute_json_stdout_or_log_content(self):
        stdout = io.StringIO()
        with patch('eval_harness.ModelClient', return_value=FakeCaller()), \
                patch('eval_harness.logging.basicConfig'), \
                self.assertLogs('eval_harness', level='INFO') as logs, redirect_stdout(stdout):
            code = main(self.args + ['--progress'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())['run_status'], 'complete')
        self.assertEqual(len(logs.output), 2)
        self.assertNotIn('sensitive question', '\n'.join(logs.output))

    def test_cli_returns_failure_with_preserved_error_rows(self):
        class FailingCaller:
            def call(self, prompt, parser=None):
                raise RuntimeError('unavailable')
        with patch('eval_harness.ModelClient', return_value=FailingCaller()), redirect_stdout(io.StringIO()):
            self.assertEqual(main(self.args), 1)
        self.assertEqual(json.loads(self.output.read_text())['failed_rows'], 2)

    def test_interrupt_preserves_finished_rows_and_marks_report(self):
        class InterruptedCaller(FakeCaller):
            calls = 0
            def call(self, prompt, parser=None):
                self.calls += 1
                if self.calls > 4:
                    raise KeyboardInterrupt()
                return super().call(prompt, parser)
        with patch('eval_harness.ModelClient', return_value=InterruptedCaller()):
            self.assertEqual(main(self.args), 130)
        report = json.loads(self.output.read_text())
        self.assertEqual(report['run_status'], 'interrupted')
        self.assertEqual(report['completed_rows'], 1)
        self.assertEqual(len(report['results']), 1)

    def test_output_cannot_overwrite_dataset(self):
        original = self.dataset.read_bytes()
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            main(['--dataset', str(self.dataset), '--output', str(self.dataset)])
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.dataset.read_bytes(), original)

    def test_offline_mode_never_constructs_model_client(self):
        with patch('eval_harness.ModelClient') as client, redirect_stdout(io.StringIO()):
            self.assertEqual(main(self.args + ['--offline']), 0)
            client.assert_not_called()
        report = json.loads(self.output.read_text())
        self.assertEqual(report['schema_version'], 1)
        self.assertEqual(report['expected_rows'], 2)
        self.assertEqual(report['run_status'], 'complete')


if __name__ == '__main__':
    unittest.main()
