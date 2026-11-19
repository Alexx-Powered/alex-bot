"""Project worker exceptions onto closed diagnostics. Raw provider text stays local."""
from urllib.error import HTTPError


VIDEO_CODES = frozenset({
    'VIDEO_NATIVE_UNAVAILABLE', 'VIDEO_SOURCE_UNAVAILABLE', 'VIDEO_SOURCE_INVALID',
    'VIDEO_SOURCE_STALE', 'VIDEO_DATA_MISSING', 'VIDEO_NO_COVERAGE',
    'VIDEO_ENCODING_FAILED', 'VIDEO_TIMEOUT', 'VIDEO_INPUT_INVALID',
})


def _model_http_error(error, status):
    if status in {400, 422}:
        body = getattr(error, 'body', None)
        if isinstance(body, dict):
            details = body.get('error', body)
            body = details.get('message') if isinstance(details, dict) else details
        if status == 400 and isinstance(body, str) and 'reasoning_content' in body[:2000].lower():
            return 'MODEL_TOOL_PROTOCOL_ERROR'
        return 'MODEL_REQUEST_REJECTED'
    return {401: 'MODEL_AUTH_ERROR', 403: 'MODEL_AUTH_ERROR', 402: 'MODEL_BALANCE_INSUFFICIENT',
            429: 'MODEL_PROVIDER_RATE_LIMITED'}.get(
                status, 'MODEL_PROVIDER_UNAVAILABLE' if status >= 500 else 'HTTP_ERROR')


def error_fields(error, *, model=False):
    try:
        return _classify(error, model)
    except Exception:
        return {}


def _classify(error, model):
    fields = {}
    # Video decoders and SDKs sometimes wrap the transport exception twice.
    for _ in range(4):
        if error is None:
            break
        code = getattr(error, 'code', None)
        status = getattr(error, 'status_code', None)
        if isinstance(error, HTTPError):
            status = code
        if status is None:
            status = getattr(getattr(error, 'response', None), 'status_code', None)
        name = type(error).__name__.lower()
        if isinstance(code, str) and code in VIDEO_CODES:
            reason = code
        elif isinstance(status, int) and 400 <= status <= 599:
            fields['httpStatus'] = status
            reason = _model_http_error(error, status) if model else 'HTTP_ERROR'
        elif 'timeout' in name or isinstance(error, TimeoutError):
            reason = 'MODEL_TIMEOUT' if model else 'NETWORK_TIMEOUT'
        elif 'connect' in name or isinstance(error, ConnectionError):
            reason = 'MODEL_CONNECTION_ERROR' if model else 'CONNECTION_ERROR'
        elif name == 'runtimeerror' and any('readtimeout' in arg[:1000].lower() for arg in error.args if isinstance(arg, str)):
            # The native decoder may expose a read timeout only as a wrapped string.
            reason = 'NETWORK_TIMEOUT'
        elif 'decode' in name:
            reason = 'DECODE_ERROR'
        elif 'validation' in name:
            reason = 'VALIDATION_ERROR'
        else:
            reason = None
        if reason and reason != fields.get('errorCode'):
            fields['causeCode' if 'errorCode' in fields else 'errorCode'] = reason
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    return fields
