"""Bounded, per-conversation preference memory; never stores a chat transcript."""
from __future__ import annotations

import os
import re
import sqlite3
import stat
import time
import unicodedata
from pathlib import Path
from typing import Annotated, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field

KINDS = ("name", "reply_style", "preference", "project")
MAX_ITEMS = 24
MAX_NAMESPACES = 256
MAX_DATABASE_BYTES = 4 * 1024 * 1024
TTL_SECONDS = 180 * 24 * 60 * 60
NAMESPACE = re.compile(r"^[a-f0-9]{64}$")
SENSITIVE = re.compile(
    r"sk-[A-Za-z0-9_-]{12,}|(?:LTAI|AKIA)[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+\S+|-----BEGIN|https?://|www\.|"
    r"(?:[A-Za-z]:[\\/]|/(?:etc|home|var|private|run)/)|"
    r"(?:api[_ -]?key|app[_ -]?secret|access[_ -]?key|token|password|passwd|"
    r"密码|密钥|令牌|学号|身份证|手机号|电话号|邮箱|银行|信用卡|银行卡|"
    r"余额|工资|薪资|存款|充值|钱包|账户|账号|健康|病史|疾病|诊断|治疗|"
    r"用药|药物|过敏|抑郁|血压|血糖|病|症|失眠|疼痛|怀孕|焦虑|残疾|医疗)|"
    r"\b\d{10,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
INSTRUCTION = re.compile(
    r"系统|提示词|指令|规则|权限|白名单|灰名单|管理员|换算|比率|HU\$|"
    r"忽略|无视|覆盖|绕过|执行|删除文件|读(?:取)?文件|所有记忆|"
    r"\b(?:system|developer|jailbreak|ignore|instructions?|prompt|sudo|shell)\b|"
    r"<\||\[\s*(?:system|developer)\s*\]", re.I)
REPORTED = re.compile(r"(?:别人|有人|他说|她说|他们说|听说|据说|转述|假设|如果|例如|举例|"
                      r"不要(?:再)?记|不用记|别(?:再)?记|不许记|不用保存|不要保存|别保存)|[“”「」『』\"`]")
TRANSIENT = re.compile(r"今天|明天|昨天|此刻|现在|今晚|今早|本节|下节|"
                       r"\d{4}-\d{2}-\d{2}|\d{1,2}[:：]\d{2}|"
                       r"(?:教室|三号楼).{0,12}(?:空闲|有课|可用)|"
                       r"(?:天气|气温|温度|PM2\.?5|AQI|雷达).{0,12}(?:是|为|度|下雨|下雪)", re.I)


def _failure(code="CHAT_MEMORY_UNAVAILABLE"):
    return {"ok": False, "code": code}


def _clean_text(value, maximum=120):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        return None
    if any(unicodedata.category(c) in {"Cc", "Cf", "Cs"} for c in value):
        return None
    return value.strip()


def _stable_fact(kind, text, source):
    text = _clean_text(text)
    if text is None or not isinstance(source, str) or len(source) > 2000 or text not in source:
        return None
    if SENSITIVE.search(source) or INSTRUCTION.search(source) or REPORTED.search(source) or re.search(r"[\w\u3400-\u9fff]{1,12}(?:说|表示|提到|写道)\s*[:：]", source):
        return None
    if kind == "name":
        valid = re.fullmatch(r"(?:我叫|我的名字是|叫我|以后(?:就)?叫我|称呼我(?:为)?)([\w\u3400-\u9fff· .-]{1,24})[。！!]?", text)
        if valid and (valid.group(1) in {'什么','啥','谁','吗','什么名字','啥名字'} or re.search(r'吗|呢|怎么|什么|是不是|好不好',valid.group(1))):
            valid=False
        if valid and not re.search(r'(?:^|[，。！？!?；;\n])\s*'+re.escape(text),source):
            valid=False
    elif kind == "reply_style":
        valid = (re.search(r"回复|回答|说话|聊天", text) and
                 re.search(r"我(?:更)?(?:喜欢|希望|想要|偏好)|跟我|和我|请|以后", text))
    elif kind == "preference":
        valid = re.match(r"我(?:更|一直|平时|通常|最|比较|不太|也|其实|真的|还是|一般)?(?:喜欢|爱|不喜欢|讨厌|偏好|习惯|不爱|更喜欢).+", text)
    elif kind == "project":
        valid = re.match(r"我(?:最近|目前|这学期)?(?:在|正在)(?:做|开发|研究|维护|搭建|制作|写).{2,}", text)
    else:
        valid = False
    if not valid or (kind != "project" and TRANSIENT.search(text)):
        return None
    return text


def auto_memory_candidates(source):
    """High-confidence first-person spans; model hints are optional, never required."""
    if not isinstance(source,str) or len(source)>320:return []
    stop=r'[^，。！？!?；;\n]'
    patterns=[
        ('name',r'(?:我叫|我的名字是|以后(?:就)?叫我|称呼我(?:为)?|叫我)[\w\u3400-\u9fff· .-]{1,24}(?=[，。！？!?；;\n]|$)'),
        ('preference',r'我(?:更|一直|平时|通常|最|比较|不太|也|其实|真的|还是|一般)?(?:喜欢|爱|不喜欢|讨厌|偏好|习惯|不爱|更喜欢)'+stop+r'{1,100}'),
        ('reply_style',r'(?:跟我|和我|以后|我希望|我更喜欢|请)'+stop+r'{0,50}(?:回复|回答|说话|聊天)'+stop+r'{0,50}'),
        ('project',r'我(?:最近|目前|这学期)?(?:在|正在)(?:做|开发|研究|维护|搭建|制作|写)'+stop+r'{2,100}'),
    ]
    facts=[]
    for kind,pattern in patterns:
        for match in re.finditer(pattern,source):
            fact=_stable_fact(kind,match.group(),source)
            if fact:facts.append({'kind':kind,'text':fact})
    return facts[:6]


class ChatMemoryStore:
    """Trusted operator supplies directory; models supply neither paths nor identities."""
    def __init__(self, directory: Path, clock=time.time):
        self.directory = Path(directory).absolute()
        self.file = self.directory / "chat-memory.sqlite3"
        self.clock = clock

    def _now(self):
        value = self.clock()
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value < 9e12:
            raise ValueError("CLOCK")
        return float(value)

    def _connect(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink() or not self.directory.is_dir():
            raise ValueError("DIRECTORY")
        if os.name != "nt":
            self.directory.chmod(0o700)
        if self.file.exists() or self.file.is_symlink():
            info = self.file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DATABASE_BYTES:
                raise ValueError("DATABASE")
        else:
            descriptor = os.open(self.file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
        if os.name != "nt":
            self.file.chmod(0o600)
        connection = sqlite3.connect(self.file, timeout=0.5)
        try:
            connection.execute("PRAGMA busy_timeout=500")
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA secure_delete=ON")
            page_size = connection.execute("PRAGMA page_size").fetchone()[0]
            connection.execute("PRAGMA max_page_count=" + str(MAX_DATABASE_BYTES // page_size))
            connection.execute("CREATE TABLE IF NOT EXISTS memories (namespace TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, updated REAL NOT NULL, PRIMARY KEY(namespace,kind,text))")
            return connection
        except Exception:
            connection.close()
            raise

    def _prune(self, connection, now):
        connection.execute("DELETE FROM memories WHERE updated <= ? OR updated > ?", (now - TTL_SECONDS, now))

    def recall(self, namespace, query="", limit=6):
        if not isinstance(namespace, str) or not NAMESPACE.fullmatch(namespace):
            return _failure("CHAT_MEMORY_INVALID")
        if not isinstance(query, str) or len(query) > 120 or isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 8:
            return _failure("CHAT_MEMORY_INVALID")
        try:
            now = self._now()
            connection = self._connect()
            try:
                with connection:
                    self._prune(connection, now)
                    rows = connection.execute("SELECT kind,text,updated FROM memories WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT ?", (namespace, MAX_ITEMS)).fetchall()
                rows = [row for row in rows if row[0] in KINDS and _stable_fact(row[0], row[1], row[1]) is not None]
                # Parameterized SQL fetches one bounded namespace; terms are never SQL.
                terms = [item.casefold() for item in re.findall(r"[\w\u3400-\u9fff]+", query)][:12]
                rows.sort(key=lambda row: (sum(term in row[1].casefold() for term in terms),row[0] in {'name','reply_style'}), reverse=True)
                return {"ok": True, "memories": [{"kind": kind, "text": text, "updated_at": updated} for kind, text, updated in rows[:limit]]}
            finally:
                connection.close()
        except Exception:
            return _failure()

    def update(self, namespace, source, action, kind="preference", text=""):
        if not isinstance(namespace, str) or not NAMESPACE.fullmatch(namespace) or action not in {"remember", "forget", "clear"} or kind not in KINDS:
            return _failure("CHAT_MEMORY_INVALID")
        fact = _stable_fact(kind, text, source) if action == "remember" else _clean_text(text) if action == "forget" and text else ""
        if action in {'forget','clear'}:
            if not isinstance(source,str) or re.search(r'(?:别|不要|不用|不想|不许).{0,4}(?:清空|删除|忘掉|忘记)',source):
                return _failure('CHAT_MEMORY_REJECTED')
            if not re.search(r'忘掉|忘记|别记|不用记|删除|清空',source):
                return _failure('CHAT_MEMORY_REJECTED')
            if action=='forget' and not fact and not re.search(r'(?:忘掉|忘记|删除).{0,4}(?:这条|那条|刚才|最后)',source):
                return _failure('CHAT_MEMORY_REJECTED')
        if fact is None:
            return _failure("CHAT_MEMORY_REJECTED")
        try:
            now = self._now()
            connection = self._connect()
            try:
                with connection:
                    self._prune(connection, now)
                    if action == "clear":
                        changed = connection.execute("DELETE FROM memories WHERE namespace=?", (namespace,)).rowcount
                    elif action == "forget":
                        # instr is literal substring matching: %, _, quotes carry no wildcard authority.
                        if fact:
                            changed = connection.execute("DELETE FROM memories WHERE namespace=? AND instr(text,?)>0", (namespace, fact)).rowcount
                        else:
                            changed = connection.execute("DELETE FROM memories WHERE rowid=(SELECT rowid FROM memories WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT 1)", (namespace,)).rowcount
                    else:
                        namespaces = connection.execute("SELECT COUNT(DISTINCT namespace) FROM memories").fetchone()[0]
                        exists = connection.execute("SELECT 1 FROM memories WHERE namespace=? LIMIT 1", (namespace,)).fetchone()
                        if not exists and namespaces >= MAX_NAMESPACES:
                            return _failure("CHAT_MEMORY_FULL")
                        if kind in {"name", "reply_style", "project"}:
                            connection.execute("DELETE FROM memories WHERE namespace=? AND kind=?", (namespace, kind))
                        connection.execute("INSERT INTO memories(namespace,kind,text,updated) VALUES(?,?,?,?) ON CONFLICT(namespace,kind,text) DO UPDATE SET updated=excluded.updated", (namespace, kind, fact, now))
                        connection.execute("DELETE FROM memories WHERE namespace=? AND rowid NOT IN (SELECT rowid FROM memories WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT ?)", (namespace, namespace, MAX_ITEMS))
                        changed = 1
                return {"ok": True, "code": {"remember": "CHAT_MEMORY_SAVED", "forget": "CHAT_MEMORY_FORGOTTEN", "clear": "CHAT_MEMORY_CLEARED"}[action], "changed": changed}
            finally:
                connection.close()
        except Exception:
            return _failure()


class RecallArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    query: Annotated[str, Field(max_length=120)] = ""
    limit: Annotated[int, Field(ge=1, le=8)] = 6


class UpdateArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["remember", "forget", "clear"]
    kind: Literal["name", "reply_style", "preference", "project"] = "preference"
    text: Annotated[str, Field(max_length=120)] = ""


def build_memory_tools(store: ChatMemoryStore, namespace: str, source: str):
    @tool("recall_chat_memory", args_schema=RecallArgs)
    def recall(query: str = "", limit: int = 6) -> dict:
        """回忆当前对话对象在本群或本人私聊中保存的稳定偏好，不访问其他人或其他会话。"""
        try:
            return store.recall(namespace, query, limit)
        except Exception:
            return _failure()

    @tool("update_chat_memory", args_schema=UpdateArgs)
    def update(action: str, kind: str = "preference", text: str = "") -> dict:
        """只保存本轮原文中明确自述的称呼、回复风格、稳定偏好、项目；可忘记匹配项或清空自己的记忆。"""
        try:
            return store.update(namespace, source, action, kind, text)
        except Exception:
            return _failure()

    return {"recall": recall, "update": update}
