# Automated RAG & Agent Evaluation Engine

An LLM-as-a-Judge quantitative evaluation harness computing Faithfulness and Context Precision with per-row failure isolation and atomic JSON report checkpointing.

## Quick Start
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
echo "GEMINI_API_KEY=your_key_here" > .env
python eval_harness.py --rpm 5

### The Architecture
Evaluating Retrieval-Augmented Generation (RAG) systems manually is unscalable. This Python engine automates benchmark dataset creation and quantitative quality testing:
1. **Synthetic Dataset Generation:** Reads raw document contexts and generates factual question–ground-truth pairs using Gemini 2.5 Flash.
2. **RAG Simulation:** Executes query generation against retrieved contexts.
3. **LLM-as-a-Judge Metrics:**
   * **Faithfulness (0.00 – 1.00):** Measures whether generated claims are strictly anchored in context (detects hallucinations).
   * **Context Precision (0.00 – 1.00):** Measures whether the retrieved chunk contains the factual details necessary to answer the question.
4. **Rate Limit Governance:** Incorporates automated throttling to comply with production API quota constraints (5 RPM Free Tier).

### Sample Execution Output
```text
Step 1: Generating Synthetic Test Bench...
Step 2: Executing RAG Evaluation Harness...

========================================================================================
EVALUATION MATRIX REPORT
========================================================================================
                                                question  faithfulness  context_precision
0  How often must Ontario condominium corporations co...           1.0                1.0
1   What components are covered by the condo reserve ...           1.0                1.0

Mean Faithfulness: 1.00 / 1.00
Mean Context Precision: 1.00 / 1.00
========================================================================================
```