"""Validated model calls with bounded retries and a shared request limiter."""
import json
import math
import os
import time
from typing import Any, Callable, Protocol, TypeVar, overload
from google import genai
from dotenv import load_dotenv

T = TypeVar('T')


class ModelCaller(Protocol):
    """Small injectable boundary; parsed calls return the parser's result type."""
    @overload
    def call(self, prompt: str, parser: None = None) -> str: ...
    @overload
    def call(self, prompt: str, parser: Callable[[Any], T]) -> T: ...


class InvalidModelResponseError(ValueError):
    """Retryable response-contract failure, distinct from local SDK errors."""


def score_reply(raw: Any) -> float:
    # Reject rather than clamp: a score of 45 indicates a broken response
    # contract, not a high-confidence score on this evaluator's 0–1 scale.
    if not isinstance(raw, dict):
        raise ValueError('Expected a score object')
    score = raw.get('score')
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError('score must be a finite number between 0 and 1')
    return float(score)


class ModelClient:
    """Sequential transport boundary, separate from evaluation semantics.

    Injected sleep/monotonic clock allow deterministic retry tests. One shared
    instance coordinates pacing; concurrent callers or separate processes need
    a synchronized limiter. A valid score is not a calibrated probability.
    """
    def __init__(self, client=None, model='gemini-2.5-flash', max_retries=2,
                 retry_delay=1.0, requests_per_minute=5, sleep=time.sleep, clock=time.monotonic,
                 max_prompt_chars=100_000):
        if isinstance(max_prompt_chars, bool) or not isinstance(max_prompt_chars, int) or max_prompt_chars < 1:
            raise ValueError('max_prompt_chars must be a positive integer')
        if isinstance(max_retries, bool) or not isinstance(max_retries, int) or max_retries < 0:
            raise ValueError('max_retries must be an integer >= 0')
        for name, value in [('retry_delay', retry_delay), ('requests_per_minute', requests_per_minute)]:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f'{name} must be a finite non-negative number')
        if requests_per_minute == 0:
            raise ValueError('requests_per_minute must be positive')
        if not isinstance(model, str) or not model.strip():
            raise ValueError('model must be a non-empty string')
        if client is None:
            load_dotenv()
            key = os.getenv('GEMINI_API_KEY')
            if not key:
                raise ValueError('GEMINI_API_KEY environment variable is required.')
            client = genai.Client(api_key=key)
        self.client, self.model = client, model
        self.max_retries, self.retry_delay = max_retries, retry_delay
        self.interval = 60.0 / requests_per_minute
        self.sleep, self.clock = sleep, clock
        self.next_request = 0.0
        self.max_prompt_chars = max_prompt_chars

    def _wait(self):
        # Start-to-start pacing includes retries. A monotonic clock avoids wall
        # clock adjustments; no sleep is charged after the last successful call.
        delay = self.next_request - self.clock()
        if delay > 0:
            self.sleep(delay)
        self.next_request = self.clock() + self.interval

    @staticmethod
    def _retryable(error):
        if isinstance(error, (InvalidModelResponseError, ConnectionError, TimeoutError)):
            return True
        code = getattr(error, 'status_code', getattr(error, 'code', None))
        if isinstance(code, int):
            return code in (408, 429) or 500 <= code <= 599
        import httpx
        return isinstance(error, httpx.TransportError)

    @overload
    def call(self, prompt: str, parser: None = None) -> str: ...

    @overload
    def call(self, prompt: str, parser: Callable[[Any], T]) -> T: ...

    def call(self, prompt: str, parser: Callable[[Any], T] | None = None) -> str | T:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError('prompt must be non-empty')
        if len(prompt) > self.max_prompt_chars:
            raise ValueError('prompt exceeds max_prompt_chars')
        # Retries address availability and malformed outputs, not answer quality.
        # These generation/judging calls have no external write side effects;
        # replaying a tool that changes state would require idempotency controls.
        for attempt in range(self.max_retries + 1):
            self._wait()
            try:
                config = {'response_mime_type': 'application/json'} if parser else {}
                response = self.client.models.generate_content(model=self.model, contents=prompt, config=config)
                text = response.text
                if not isinstance(text, str) or not text.strip():
                    raise InvalidModelResponseError('Model returned empty text')
                if parser:
                    try:
                        return parser(json.loads(text))
                    except ValueError as error:
                        raise InvalidModelResponseError(str(error)) from error
                return text.strip()
            except Exception as error:
                if not self._retryable(error) or attempt == self.max_retries:
                    raise RuntimeError(f'Model call failed after {attempt + 1} tries: {error}') from error
                # Bound exponential growth before exponentiation; unlike a
                # request deadline, this only limits the inter-request delay.
                delay = 0.0 if self.retry_delay == 0 else min(30.0, self.retry_delay * 2 ** min(attempt, 30))
                self.sleep(delay)
