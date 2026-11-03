"""Bounded in-process quantities from trusted tools, never a chat transcript.

Callers supply the existing trusted session key and authorization context.  Only
``summary`` is suitable for a model prompt; it deliberately omits the amount.
"""
from __future__ import annotations

import math
import re
import time
from collections import OrderedDict
from dataclasses import dataclass

from langchain.tools import tool

from conversions import ConversionArgs, convert_quantity


@tool(args_schema=ConversionArgs, return_direct=True)
def _convert_followup_quantity(amount: str, from_unit: str, to_unit: str) -> str:
    """Convert one validated prior tool quantity using the fixed local ratios."""
    return convert_quantity(amount, from_unit, to_unit)


_AMOUNT = r"-?[0-9]{1,16}(?:\.[0-9]{1,8})?"
_BALANCE_ROW = re.compile(
    rf"可用 ({_AMOUNT}) (CNY|USD)（赠金 ({_AMOUNT})，充值余额 ({_AMOUNT})）"
)
_CHECKED_AT = re.compile(
    r"查询时间：(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]) "
    r"([01][0-9]|2[0-3]):[0-5][0-9]（北京时间）"
)
_OUTPUT_LABELS = {"HU$": "HU$", "元": "CNY", "马里": "马里", "km": "km",
                  "m": "m", "马时": "马时", "小时": "h", "分钟": "min",
                  "全马": "marathon", "半马": "half_marathon"}
_RESULT = re.compile(
    r"[0-9]{1,12}(?:\.[0-9]{1,8})? (?:HU\$|元|马里|km|m|马时|小时|分钟|全马|半马) "
    r"[=≈] ([0-9]{1,16}(?:\.[0-9]{1,6})?) (HU\$|元|马里|km|m|马时|小时|分钟|全马|半马)"
)

_FOLLOWUP_ALIASES = {
    "古月币": "HU$", "hu$": "HU$", "人民币": "CNY", "cny": "CNY", "rmb": "CNY",
    "元": "CNY", "块钱": "CNY", "块": "CNY", "¥": "CNY", "￥": "CNY",
    "马里": "马里", "公里": "km", "千米": "km", "km": "km", "米": "m", "m": "m",
    "马时": "马时", "小时": "h", "h": "h", "分钟": "min", "分": "min", "min": "min",
}
_FOLLOWUP_UNIT = "|".join(re.escape(alias) for alias in sorted(_FOLLOWUP_ALIASES, key=len, reverse=True))
_FOLLOWUP_LEAD = (
    r"(?:那(?:么)?|然后|再|也|所以|请|帮我|给我|麻烦|能不能|能否|可以|能|把|将|大概|大约|"
    r"这些钱|这笔钱|这个数值|这个结果|这个金额|这个数|这些|这个|它|"
    r"(?:刚才|上面|之前)(?:的)?(?:那个|这个)?(?:数值|结果|金额|余额|钱))"
)
_FOLLOWUP = re.compile(
    rf"^(?:{_FOLLOWUP_LEAD}\s*[,，]?\s*){{0,6}}"
    r"(?:(?:换算|转换|折算|折合|换|折)(?:一下)?(?:成|回|为|到)?|相当于|等于|是|有|能有)?"
    r"\s*(?:多少|几)?(?:个)?\s*"
    rf"(?P<unit>{_FOLLOWUP_UNIT})"
    r"\s*(?:(?:的)?(?:金额|数值|数额|数量)?(?:大概|大约)?(?:是|有|能有)?多少)?"
    r"\s*(?:呀|啊|呢|吧|吗|嘛|哦|啦|呐|哇|捏|哟|喵|哈|[~～?？。!！])*\s*$",
    re.I,
)


def resolve_followup_unit(text):
    """Recognize one omitted-quantity follow-up, never a new amount or query.

    This only returns a target unit.  The caller must separately require a
    trusted unexpired quantity and invoke the fixed conversion tool.  Whole
    string matching intentionally declines extra tasks, source/target pairs,
    rate overrides, unknown currencies and requests for a fresh balance.
    """
    if not isinstance(text, str) or not 1 <= len(text) <= 160 or re.search(r"\d|[\r\n]", text):
        return None
    value = text.strip()
    # A bare unit/currency is not a request to convert a prior quantity.
    if not re.search(r"换|折|相当于|等于|多少|几", value):
        return None
    matched = _FOLLOWUP.fullmatch(value)
    return _FOLLOWUP_ALIASES.get(matched.group("unit").lower()) if matched else None


@dataclass(frozen=True)
class _Quantity:
    created: float
    amount: str
    unit: str
    source: str
    sensitive: bool
    original_amount: str
    original_unit: str


class ToolResultContext:
    """One current quantity per scope/member/access, for at most ten minutes.

    ``remember_*`` return bool and replace (or invalidate) the prior quantity.
    ``convert`` returns an allowlisted result dict, updating the current output
    quantity on success.  Further conversions use the original exact input, not
    a six-decimal display approximation.  Balances retain their query-time
    expiry across conversions; they are not persisted or sent to model prompts.
    """

    def __init__(self, clock=time.monotonic, max_sessions=64, ttl_seconds=600):
        if (not callable(clock) or type(max_sessions) is not int or not 1 <= max_sessions <= 64
                or type(ttl_seconds) not in {int, float} or not math.isfinite(ttl_seconds)
                or not 0 < ttl_seconds <= 600):
            raise ValueError("TOOL_CONTEXT_CONFIG_INVALID")
        self._clock = clock
        self._maximum = max_sessions
        self._ttl = ttl_seconds
        self._quantities: OrderedDict[tuple[str, str, str], _Quantity] = OrderedDict()

    def clear(self):
        self._quantities.clear()

    def forget(self, session_key, context):
        """Invalidate just this trusted session, without clearing other members."""
        key, _, _ = self._lookup(session_key, context)
        return key is not None and self._quantities.pop(key, None) is not None

    def _now(self):
        try:
            value = self._clock()
            if type(value) not in {int, float} or not math.isfinite(value) or value < 0:
                raise ValueError()
            return float(value)
        except Exception:
            self.clear()
            return None

    def _prune(self, now):
        for key, value in list(self._quantities.items()):
            if now < value.created or now - value.created >= self._ttl:
                del self._quantities[key]

    def _key(self, session_key, context):
        if (not isinstance(session_key, str) or not 1 <= len(session_key) <= 256
                or not isinstance(context, dict)):
            return None
        scope = context.get("scope")
        if scope == "c2c":
            return session_key, "c2c", "owner"
        if scope != "group":
            return None
        raw_access = context.get("access")
        access = raw_access if isinstance(raw_access, str) else None
        if access not in {"white", "gray"}:
            return None
        # Every permission revision gets its own transient quantity context.
        # This prevents a disabled then reenabled balance tool reviving old facts.
        features=context.get('features')
        if features is not None:
            import json
            access=access+':'+str(context.get('policyRevision',0))+':'+json.dumps(features,sort_keys=True,separators=(',',':'))
        for existing in list(self._quantities):
            if existing[:2] == (session_key, "group") and existing[2] != access:
                del self._quantities[existing]
        return session_key, "group", access

    def _lookup(self, session_key, context):
        key, now = self._key(session_key, context), self._now()
        if now is None:
            return key, None, None
        self._prune(now)
        value = self._quantities.get(key) if key is not None else None
        if value is not None:
            self._quantities.move_to_end(key)
        return key, now, value

    @staticmethod
    def _full(key):
        return key is not None and (key[1] == "c2c" or key[2].split(':',1)[0] == "white")

    def _put(self, key, value):
        self._quantities[key] = value
        self._quantities.move_to_end(key)
        while len(self._quantities) > self._maximum:
            self._quantities.popitem(last=False)

    @staticmethod
    def _output_quantity(result):
        if not isinstance(result, str) or len(result) > 100:
            raise ValueError()
        match = _RESULT.fullmatch(result)
        if match is None:
            raise ValueError()
        amount, label = match.groups()
        unit = _OUTPUT_LABELS[label]
        # This is display output.  The next operation uses the bounded original
        # input instead, so a larger converted display does not widen its schema.
        return amount, unit

    def remember_balance(self, session_key, context, text):
        key, now, _ = self._lookup(session_key, context)
        if key is not None:
            self._quantities.pop(key, None)
        if now is None or not self._full(key):
            return False
        try:
            if not isinstance(text, str) or len(text) > 1000:
                raise ValueError()
            lines = text.splitlines()
            if (len(lines) not in {4, 5} or lines[0] != "DeepSeek API 账户余额："
                    or lines[-2] not in {"可供 API 调用：是", "可供 API 调用：否"}
                    or _CHECKED_AT.fullmatch(lines[-1]) is None):
                raise ValueError()
            rows = [_BALANCE_ROW.fullmatch(line) for line in lines[1:-2]]
            if any(row is None for row in rows):
                raise ValueError()
            currencies = [row.group(2) for row in rows]
            if len(currencies) != len(set(currencies)) or "CNY" not in currencies:
                raise ValueError()
            amount = next(row.group(1) for row in rows if row.group(2) == "CNY")
            ConversionArgs.model_validate({"amount": amount, "from_unit": "CNY", "to_unit": "HU$"})
            self._put(key, _Quantity(now, amount, "CNY", "balance", True, amount, "CNY"))
            return True
        except Exception:
            return False

    def remember_conversion(self, session_key, context, amount, from_unit, to_unit, result, sensitive=False):
        key, now, previous = self._lookup(session_key, context)
        if key is not None:
            self._quantities.pop(key, None)
        if key is None or now is None or type(sensitive) is not bool or (sensitive and not self._full(key)):
            return False
        try:
            args = ConversionArgs.model_validate({"amount": amount, "from_unit": from_unit, "to_unit": to_unit})
            if convert_quantity(args.amount, args.from_unit, args.to_unit) != result:
                raise ValueError()
            output_amount, output_unit = self._output_quantity(result)
            created = previous.created if sensitive and previous and previous.sensitive else now
            self._put(key, _Quantity(created, output_amount, output_unit,
                                     "balance" if sensitive else "conversion", sensitive,
                                     args.amount, args.from_unit))
            return True
        except Exception:
            return False

    def summary(self, session_key, context):
        _, _, value = self._lookup(session_key, context)
        if value is None:
            return {"available": False}
        return {"available": True, "unit": value.unit, "source": value.source, "sensitive": value.sensitive}

    def convert(self, session_key, context, to_unit):
        key, now, value = self._lookup(session_key, context)
        if value is None or now is None or (value.sensitive and not self._full(key)):
            return {"ok": False, "code": "TOOL_CONTEXT_MISSING"}
        try:
            result = _convert_followup_quantity.invoke({"amount": value.original_amount, "from_unit": value.original_unit,
                                                        "to_unit": to_unit})
            amount, unit = self._output_quantity(result)
            self._put(key, _Quantity(value.created if value.sensitive else now, amount, unit,
                                     value.source, value.sensitive, value.original_amount, value.original_unit))
            return {"ok": True, "text": result, "source": value.source, "sensitive": value.sensitive}
        except Exception:
            # A failed new operation must never fall back to an older quantity.
            self._quantities.pop(key, None)
            return {"ok": False, "code": "TOOL_CONTEXT_CONVERSION_INVALID"}
