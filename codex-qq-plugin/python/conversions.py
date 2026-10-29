"""Fixed, exact custom-unit arithmetic used only through the LangChain tool."""
from decimal import Decimal, ROUND_HALF_UP, localcontext
from fractions import Fraction
import re
from typing import Annotated, Literal
from datetime import date
import calendar

from pydantic import BaseModel, ConfigDict, Field

Unit = Literal["HU$", "CNY", "马里", "km", "m", "马时", "h", "min", "marathon", "half_marathon"]


class ConversionArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    amount: Annotated[str, Field(min_length=1, max_length=21,
                                pattern=r"^[0-9]{1,12}(?:\.[0-9]{1,8})?$",
                                description="非负十进制字符串，例如0.6；最多12位整数、8位小数，不接受算式或科学计数法")]
    from_unit: Unit
    to_unit: Unit


# Reference bases: CNY, metres and minutes. Ratios are user-defined constants.
_UNITS = {
    "HU$": ("money", Fraction(350, 3), "HU$"),
    "CNY": ("money", Fraction(1), "元"),
    "马里": ("distance", Fraction(3080), "马里"),
    "km": ("distance", Fraction(1000), "km"),
    "m": ("distance", Fraction(1), "m"),
    "马时": ("time", Fraction(90), "马时"),
    "h": ("time", Fraction(60), "小时"),
    "min": ("time", Fraction(1), "分钟"),
    "marathon": ("distance", Fraction(42195), "全马"),
    "half_marathon": ("distance", Fraction(42195, 2), "半马"),
}

class LivingArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    balance: Annotated[str, Field(pattern=r"^[0-9]{1,12}(?:\.[0-9]{1,8})?$", max_length=21)]
    unit: Literal["HU$", "CNY"]

def living_budget(balance: str, unit: str, today: date) -> dict:
    args = LivingArgs.model_validate({"balance": balance, "unit": unit})
    funds = Fraction(args.balance) * _UNITS[args.unit][1]
    year, month = today.year, today.month
    if today.day >= 10:
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    payday = date(year, month, 10)
    days = (payday - today).days
    required = Fraction(days * 50)
    number = lambda value: _plain((Decimal(value.numerator) / Decimal(value.denominator)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
    return {"today": today.isoformat(), "next_payday": payday.isoformat(), "days_including_today_excluding_payday": days,
            "balance_cny": number(funds), "daily_cny": 50, "required_cny": number(required),
            "enough": funds >= required, "surplus_or_shortfall_cny": number(abs(funds-required)),
            "full_days_affordable": funds // 50,
            "assumptions": "每天50元生活费，从今天算到发薪前一天，不含房租、债务等额外支出；每月10日到账，10日当天按本月工资已发计算到下月10日；不调整周末节假日"}


def _plain(value: Decimal) -> str:
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def convert_quantity(amount: str, from_unit: str, to_unit: str) -> str:
    args = ConversionArgs.model_validate({"amount": amount, "from_unit": from_unit, "to_unit": to_unit})
    source, target = _UNITS[args.from_unit], _UNITS[args.to_unit]
    if source[0] != target[0]:
        raise ValueError("CONVERSION_UNIT_MISMATCH")
    exact = Fraction(args.amount) * source[1] / target[1]
    with localcontext() as context:
        context.prec = 60
        rounded = (Decimal(exact.numerator) / Decimal(exact.denominator)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
    relation = "=" if Fraction(rounded) == exact else "≈"
    return f"{_plain(Decimal(args.amount))} {source[2]} {relation} {_plain(rounded)} {target[2]}"


def is_conversion_request(text: str) -> bool:
    """Recognise explicit custom-unit questions; Mali as a country is not a unit request."""
    return bool(re.search(r"古月币|HU\$|马里|马时", text, re.I) and
                re.search(r"换算|兑换|换成|折合|相当于|等于|汇率|比率|比例|多少|几(?:元|块|小时|公里)|多远|多久|多长时间|convert|how\s+(?:much|many)", text, re.I))
