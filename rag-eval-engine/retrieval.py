"""Small lexical retrieval baseline; no embeddings or vector database."""
import re
import heapq

STOPWORDS = {'a', 'an', 'the', 'is', 'are', 'of', 'to', 'in', 'and', 'for', 'what', 'how', 'does', 'do', 'must'}


def terms(text):
    return set(re.findall(r'[a-z0-9]+', text.lower())) - STOPWORDS


def retrieve(question, documents, top_k=3):
    """Return an interpretable baseline for comparison with richer retrievers.

    Unique-token overlap ignores frequency, synonyms, and document length.
    Stable ties make offline runs reproducible; they do not imply relevance.
    Zero-overlap chunks remain candidates, so callers must handle insufficient
    context rather than interpreting top-k retrieval as evidence of an answer.
    """
    index = LexicalRetriever(documents)
    return [index.documents[i] for i in index.retrieve_ids(question, top_k)]


class LexicalRetriever:
    """Cache corpus tokens once; retain document identity even for duplicate text.

    A bounded heap selects top-k in O(N log k) comparison work instead of fully
    sorting N scores. Token intersections still scan the corpus; this is a small
    baseline, not a search index suitable for arbitrarily large collections.
    """
    def __init__(self, documents):
        if not isinstance(documents, list) or not documents:
            raise ValueError('documents must be a non-empty list')
        if any(not isinstance(d, str) or not d.strip() for d in documents):
            raise ValueError('documents must contain non-empty strings')
        self.documents = tuple(documents)
        self.tokens = tuple(terms(d) for d in self.documents)

    def retrieve_ids(self, question, top_k=3):
        if not isinstance(question, str) or not question.strip():
            raise ValueError('question must be non-empty')
        if isinstance(top_k, bool) or not isinstance(top_k, int) or top_k < 1:
            raise ValueError('top_k must be an integer >= 1')
        query = terms(question)
        return heapq.nsmallest(top_k, range(len(self.documents)),
                               key=lambda i: (-len(query & self.tokens[i]), i))


def average_precision(relevance):
    """Compute sum(precision@k * relevant[k]) / sum(relevant).

    This denominator counts relevant *retrieved* chunks, not all relevant
    documents in the corpus. Missing documents therefore require a separate
    recall measure. Trailing noise after all relevant chunks does not reduce
    this score: [True, False] scores 1, while [False, True] scores 0.5.
    No relevant chunks scores 0 by explicit convention.
    """
    if any(type(value) is not bool for value in relevance):
        raise ValueError('relevance must contain booleans')
    hits = 0
    total = 0.0
    for rank, relevant in enumerate(relevance, 1):
        if relevant:
            hits += 1
            total += hits / rank
    return total / hits if hits else 0.0
