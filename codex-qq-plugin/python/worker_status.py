"""Verify provider status snapshots before composing a group reply."""
from datetime import datetime
from io import BytesIO
import os
from pathlib import Path
import re
import stat
import time
from typing import Annotated, Literal

from PIL import Image
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from provider_status import Provider, SOURCES, ai_service_status
from public_status import OUTPUT, SOURCES as PUBLIC_SOURCES, liang_status
from worker_artifacts import publish, render_canvas

PNG_LIMIT = 1_500_000


def clean(value):
    if re.search(r"[@<>\x00-\x08\x0b-\x1f\x7f]", value):
        raise ValueError("STATUS_RESULT_INVALID")
    return value


def bounded_text(limit):
    return Annotated[str, StringConstraints(max_length=limit), AfterValidator(clean)]


def timestamp(value):
    if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", value):
        raise ValueError("STATUS_TIME_INVALID")
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


Timestamp = Annotated[str, AfterValidator(timestamp)]


class StatusModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Component(StatusModel):
    label: bounded_text(100)
    sourceName: bounded_text(100)
    state: Literal["operational", "degraded_performance", "partial_outage", "major_outage",
                   "under_maintenance", "unknown", "affected"]


class Incident(StatusModel):
    title: bounded_text(200)
    phase: bounded_text(40)
    affected: bounded_text(500)
    symptom: bounded_text(600)
    progress: bounded_text(600)
    updatedAt: Timestamp | None
    eta: bounded_text(200)


class Report(StatusModel):
    provider: Provider
    title: bounded_text(30)
    source: str
    checkedAt: Timestamp
    mode: Literal["snapshot"]
    overall: Literal["operational", "incident", "unknown"]
    rows: list[Component] = Field(max_length=100)
    incidents: list[Incident] = Field(max_length=100)
    incidentCount: int = Field(ge=0, le=100)
    notice: Incident | None = None
    listLabel: bounded_text(60)
    statusTitle: bounded_text(30)
    summary: bounded_text(150)
    scopeNote: bounded_text(150) | None = None
    sourceLabel: bounded_text(40) | None = None


class Envelope(StatusModel):
    source: str
    checked_at: Timestamp
    text: bounded_text(3900)


class ProviderResult(Envelope):
    service: Provider
    report: Report


class LiangResult(Envelope):
    service: Literal["liang"]
    ok: bool
    artifact_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")] | None


def verify_envelope(result, provider, source):
    checked = datetime.fromisoformat(result.checked_at.replace("Z", "+00:00")).timestamp()
    if not -60 <= time.time() - checked <= 120:
        raise ValueError("STATUS_RESULT_STALE")
    if result.service != provider or result.source != source or not result.text.endswith("来源：" + source):
        raise ValueError("STATUS_RESULT_INVALID")


def verify_png(data, *, liang=False):
    if not isinstance(data, bytes) or not 45 <= len(data) <= PNG_LIMIT:
        raise ValueError("STATUS_IMAGE_INVALID")
    with Image.open(BytesIO(data), formats=["PNG"]) as image:
        if image.width * image.height > 20_000_000 or (liang and (image.width != 1080 or not 200 <= image.height <= 7000)):
            raise ValueError("STATUS_IMAGE_INVALID")
        image.verify()
    return data


def liang_reply(request_id):
    result = LiangResult.model_validate(liang_status.invoke({}))
    source = PUBLIC_SOURCES["liang"]
    if result.ok != (result.artifact_id is not None):
        raise ValueError("STATUS_RESULT_INVALID")
    if not result.ok:
        verify_envelope(result, "liang", source)
        return {"text": result.text}
    file = Path(OUTPUT) / (result.artifact_id + ".png")
    try:
        verify_envelope(result, "liang", source)
        if file.is_symlink():
            raise ValueError("STATUS_IMAGE_INVALID")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(file, flags), "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or not 45 <= info.st_size <= PNG_LIMIT:
                raise ValueError("STATUS_IMAGE_INVALID")
            data = handle.read(PNG_LIMIT + 1)
        if len(data) != info.st_size:
            raise ValueError("STATUS_IMAGE_INVALID")
        media = publish(request_id, "png", verify_png(data, liang=True))
        return {"text": result.text, "richMedia": True, **media}
    finally:
        file.unlink(missing_ok=True)


def provider_reply(provider, request_id):
    result = ProviderResult.model_validate(ai_service_status.invoke({"provider": provider}))
    verify_envelope(result, provider, SOURCES[provider])
    report = result.report
    if report.provider != provider or report.source != result.source or report.checkedAt != result.checked_at:
        raise ValueError("STATUS_RESULT_INVALID")
    if report.incidentCount != len(report.incidents):
        raise ValueError("STATUS_RESULT_INVALID")
    if report.overall == "operational":
        if report.incidents or report.notice or any(row.state != "operational" for row in report.rows):
            raise ValueError("STATUS_RESULT_INVALID")
    elif not report.incidents and not report.notice:
        raise ValueError("STATUS_RESULT_INVALID")
    png = render_canvas("status", report.model_dump(exclude_unset=True))
    return {"text": result.text, "richMedia": True, **publish(request_id, "png", verify_png(png))}


def status_reply(name, args, request_id):
    provider = {"liang_status": "liang", "deepseek_service_status": "deepseek"}.get(name)
    if name == "ai_service_status" and set(args) == {"provider"} and args["provider"] in SOURCES:
        provider = args["provider"]
    elif provider is None or args:
        raise ValueError("STATUS_TOOL_DENIED")
    source = PUBLIC_SOURCES["liang"] if provider == "liang" else SOURCES[provider]
    try:
        if provider == "liang":
            return liang_reply(request_id)
        return provider_reply(provider, request_id)
    except Exception:
        return {"text": "这次状态查询未能完成，暂不能确认服务是否正常。\n来源：" + source}
