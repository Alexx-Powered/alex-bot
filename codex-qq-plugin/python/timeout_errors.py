"""Classify exceptions without serializing provider text, URLs or credentials."""
def is_timeout(error):
    for _ in range(3):
        if isinstance(error, TimeoutError) or 'timeout' in type(error).__name__.lower():
            return True
        nested=getattr(error,'reason',None)
        if not isinstance(nested,BaseException) or nested is error:
            return False
        error=nested
    return False
