"""Scoped social memory. No diagnoses, identity guesses, or permanent mood labels."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Annotated, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field

from chat_memory import ChatMemoryStore, NAMESPACE, SENSITIVE, INSTRUCTION, REPORTED, auto_memory_candidates

MOOD_TTL = 72 * 3600
MOOD_HALF_LIFE = 4 * 3600
STYLE_HALF_LIFE = 30 * 86400
MEDIA_TTL = 30 * 86400
MAX_SOCIAL_NAMESPACES = 256
MAX_EVENTS = 24
MAX_MEDIA = 12
# Linguistic evidence only: no facial/vocal emotion detection or health inference.
MOODS = {
    '开心': r'我.{0,5}(?:好开心|很开心|太开心|好高兴|很高兴|好快乐)|终于.{0,16}(?:搞定|做完|成功|通过)|开心死了',
    '烦躁': r'我.{0,6}(?:好烦|很烦|烦死|气死|好生气|很生气)|气死我了|烦死我了',
    '难过': r'我.{0,5}(?:好难过|很难过|好伤心|很伤心|不开心)|难过死了',
    '疲惫': r'我.{0,5}(?:好累|很累|累死|好困|很困)|累死我了',
    '有压力': r'我.{0,6}(?:压力好大|压力很大|快忙不过来|忙不过来)|压力太大了',
}


def clean_source(text):
    return isinstance(text, str) and 0 < len(text) <= 2000 and not (
        SENSITIVE.search(text) or INSTRUCTION.search(text) or REPORTED.search(text))


def emotional_cue(text):
    if not clean_source(text):
        return None
    # The last explicit feeling wins, e.g. "刚才好烦，不过我现在很开心".
    found = [(m.start(), label, m.group()[:60]) for label, pattern in MOODS.items()
             for m in re.finditer(pattern, text)]
    if not found:
        return None
    _, label, evidence = max(found)
    return {'label': label, 'evidence': evidence, 'confidence': 0.8}


class SocialMemory:
    def __init__(self, directory: Path, clock=None):
        self.base = ChatMemoryStore(directory, **({'clock': clock} if clock else {}))

    def _connect(self):
        c = self.base._connect()
        c.executescript('''
          CREATE TABLE IF NOT EXISTS social_profiles (
            namespace TEXT PRIMARY KEY, scope TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
            samples REAL NOT NULL DEFAULT 0, chars REAL NOT NULL DEFAULT 0,
            playful REAL NOT NULL DEFAULT 0, updated REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS social_events (
            namespace TEXT NOT NULL, event TEXT NOT NULL, label TEXT NOT NULL,
            evidence TEXT NOT NULL, updated REAL NOT NULL, PRIMARY KEY(namespace,event));
          CREATE TABLE IF NOT EXISTS social_seen (
            namespace TEXT NOT NULL, event TEXT NOT NULL, updated REAL NOT NULL,
            PRIMARY KEY(namespace,event));
          CREATE TABLE IF NOT EXISTS social_traits (namespace TEXT NOT NULL,label TEXT NOT NULL,evidence TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(namespace,label));
          CREATE TABLE IF NOT EXISTS social_media (
            namespace TEXT NOT NULL, scope TEXT NOT NULL, event TEXT NOT NULL,
            kind TEXT NOT NULL, summary TEXT NOT NULL, updated REAL NOT NULL,
            PRIMARY KEY(namespace,event));
        ''')
        return c

    @staticmethod
    def _keys(*keys):
        if not all(isinstance(k, str) and NAMESPACE.fullmatch(k) for k in keys):
            raise ValueError('INVALID_SCOPE')

    def _prune(self, c, now):
        self.base._prune(c, now)
        for table, ttl in [('social_events', MOOD_TTL), ('social_seen', 86400),
                           ('social_media', MEDIA_TTL),('social_traits',180*86400)]:
            c.execute(f'DELETE FROM {table} WHERE updated<=? OR updated>?', (now-ttl, now))
        # Disabled profiles survive expiry so opting out cannot silently revert.
        c.execute('DELETE FROM social_profiles WHERE enabled=1 AND updated<?', (now-180*86400,))

    def observe(self, namespace, scope, event, text):
        self._keys(namespace, scope, event)
        if not isinstance(text, str) or len(text) > 2000:
            raise ValueError('INVALID_TEXT')
        now = self.base._now()
        c = self._connect()
        try:
            with c:
                self._prune(c, now)
                profile = c.execute('SELECT enabled,samples,chars,playful,updated,scope FROM social_profiles WHERE namespace=?', (namespace,)).fetchone()
                if profile and profile[5]!=scope:raise ValueError('INVALID_SCOPE')
                if profile and not profile[0]:
                    return {'ok': True, 'observed': False, 'disabled': True}
                if c.execute('SELECT 1 FROM social_seen WHERE namespace=? AND event=?', (namespace,event)).fetchone():
                    return {'ok': True, 'observed': False}
                if not profile and c.execute('SELECT COUNT(*) FROM social_profiles').fetchone()[0] >= MAX_SOCIAL_NAMESPACES:
                    return {'ok': False, 'code': 'SOCIAL_MEMORY_FULL'}
                c.execute('INSERT INTO social_seen VALUES(?,?,?)', (namespace,event,now))
                c.execute('DELETE FROM social_seen WHERE namespace=? AND rowid NOT IN (SELECT rowid FROM social_seen WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT 64)', (namespace,namespace))
                safe = clean_source(text)
                decay = 2 ** (-max(0,now-profile[4])/STYLE_HALF_LIFE) if profile else 0
                count, chars, playful = ([profile[i]*decay for i in (1,2,3)] if profile else [0,0,0])
                # Numerical communication habits, not an inferred personality or character judgement.
                if safe:
                    count += 1; chars += min(len(text),320)
                    playful += bool(re.search(r'哈哈|嘿嘿|嘻嘻|~|～|😂|🤣|摸鱼|\[狗头\]',text))
                c.execute('INSERT INTO social_profiles VALUES(?,?,1,?,?,?,?) ON CONFLICT(namespace) DO UPDATE SET samples=excluded.samples,chars=excluded.chars,playful=excluded.playful,updated=excluded.updated', (namespace,scope,count,chars,playful,now))
                cue = emotional_cue(text)
                if cue:
                    c.execute('INSERT OR REPLACE INTO social_events VALUES(?,?,?,?,?)', (namespace,event,cue['label'],cue['evidence'],now))
                    c.execute('DELETE FROM social_events WHERE namespace=? AND rowid NOT IN (SELECT rowid FROM social_events WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT ?)', (namespace,namespace,MAX_EVENTS))
            # Existing preference validator requires exact first-person evidence.
            for fact in auto_memory_candidates(text) if safe else []:
                self.base.update(namespace,text,'remember',fact['kind'],fact['text'])
            return {'ok': True, 'observed': True}
        finally:
            c.close()

    def recall(self, namespace, scope):
        self._keys(namespace,scope)
        now = self.base._now(); c = self._connect()
        try:
            with c:
                self._prune(c,now)
                p = c.execute('SELECT enabled,samples,chars,playful,updated FROM social_profiles WHERE namespace=? AND scope=?', (namespace,scope)).fetchone()
                if p is None and c.execute('SELECT 1 FROM social_profiles WHERE namespace=?',(namespace,)).fetchone():
                    return {'ok':False,'code':'INVALID_SCOPE','mood':[],'style':{},'media':[]}
                if p and not p[0]:
                    return {'ok': True, 'disabled': True, 'mood': [], 'style': {}, 'media': []}
                rows = c.execute('SELECT label,evidence,updated FROM social_events WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT ?', (namespace,MAX_EVENTS)).fetchall()
                traits=c.execute('SELECT label,updated FROM social_traits WHERE namespace=? ORDER BY updated DESC LIMIT 5',(namespace,)).fetchall()
                media = c.execute('SELECT kind,summary,updated FROM social_media WHERE namespace=? AND scope=? ORDER BY updated DESC,rowid DESC LIMIT 4', (namespace,scope)).fetchall()
            moods = [{'label': label, 'said': evidence, 'at': at,
                      'basis':'explicit' if emotional_cue(evidence) else 'context_inference',
                      'weight': round(0.8*2**(-(now-at)/MOOD_HALF_LIFE),3)} for label,evidence,at in rows]
            moods = [m for m in moods if m['weight'] >= .08][:4]
            style = {}
            effective = p[1]*2**(-max(0,now-p[4])/STYLE_HALF_LIFE) if p else 0
            if p and effective >= 4:
                style = {'effective_samples': round(effective,1), 'mean_message_chars': round(p[2]/p[1]),
                         'playful_expression_ratio': round(p[3]/p[1],2)}
            return {'ok': True, 'disabled': False, 'mood': moods, 'style': style,
                    'media': [{'kind': k,'summary': s,'at': at} for k,s,at in media],
                    'habits':[{'label':label,'at':at,'weight':round(2**(-(now-at)/(60*86400)),3)} for label,at in traits],
                    'preferences':self.base.recall(namespace,limit=8).get('memories',[])}
        finally:
            c.close()

    def remember_media(self, namespace, scope, event, kind, summary):
        self._keys(namespace,scope,event)
        if kind not in {'image','meme','audio'} or not clean_source(summary) or len(summary)>600:
            return {'ok':False,'code':'SOCIAL_MEDIA_REJECTED'}
        now=self.base._now();c=self._connect()
        try:
            with c:
                self._prune(c,now)
                p=c.execute('SELECT enabled FROM social_profiles WHERE namespace=? AND scope=?',(namespace,scope)).fetchone()
                if not p or not p[0]:return {'ok':True,'saved':False}
                c.execute('INSERT OR REPLACE INTO social_media VALUES(?,?,?,?,?,?)',(namespace,scope,event,kind,summary,now))
                c.execute('DELETE FROM social_media WHERE namespace=? AND rowid NOT IN (SELECT rowid FROM social_media WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT ?)',(namespace,namespace,MAX_MEDIA))
            return {'ok':True,'saved':True}
        finally:c.close()

    def reserve_media(self, event, kind):
        self._keys(event)
        if kind not in {'image','audio','insight'}:raise ValueError('INVALID_MEDIA')
        now=self.base._now();day=int((now+8*3600)//86400)
        c=self._connect()
        try:
            c.execute('CREATE TABLE IF NOT EXISTS social_media_attempts (event TEXT PRIMARY KEY,day INTEGER NOT NULL,kind TEXT NOT NULL)')
            with c:
                c.execute('DELETE FROM social_media_attempts WHERE day<?',(day-1,))
                if c.execute('SELECT 1 FROM social_media_attempts WHERE event=?',(event,)).fetchone():
                    return {'ok':False,'code':'MEDIA_ALREADY_PROCESSED'}
                count=c.execute('SELECT COUNT(*) FROM social_media_attempts WHERE day=? AND kind=?',(day,kind)).fetchone()[0]
                if count >= ({'image':200,'audio':30,'insight':60}[kind]):return {'ok':False,'code':'MEDIA_DAILY_LIMIT'}
                c.execute('INSERT INTO social_media_attempts VALUES(?,?,?)',(event,day,kind))
            return {'ok':True}
        finally:c.close()

    def remember_insights(self, namespace, scope, event, insights):
        self._keys(namespace,scope,event)
        from conversation_insights import TRAITS
        now=self.base._now();c=self._connect()
        try:
            with c:
                p=c.execute('SELECT enabled FROM social_profiles WHERE namespace=? AND scope=?',(namespace,scope)).fetchone()
                if not p or not p[0]:return {'ok':True,'saved':False}
                mood=insights.get('mood')
                if mood and mood.get('label') in MOODS and clean_source(mood.get('evidence')):
                    c.execute('INSERT OR REPLACE INTO social_events VALUES(?,?,?,?,?)',(namespace,event,mood['label'],mood['evidence'],now))
                for habit in insights.get('habits',[])[:3]:
                    if habit['label'] in TRAITS:
                        c.execute('INSERT OR REPLACE INTO social_traits VALUES(?,?,?,?)',(namespace,habit['label'],json.dumps(habit['evidence'],ensure_ascii=False),now))
                self._prune(c,now)
                c.execute('DELETE FROM social_events WHERE namespace=? AND rowid NOT IN (SELECT rowid FROM social_events WHERE namespace=? ORDER BY updated DESC,rowid DESC LIMIT ?)',(namespace,namespace,MAX_EVENTS))
            return {'ok':True,'saved':True}
        finally:c.close()

    def control(self, namespace, scope, action):
        self._keys(namespace,scope)
        if action not in {'off','on','clear'}:raise ValueError('INVALID_ACTION')
        now=self.base._now();c=self._connect()
        try:
            with c:
                self._prune(c,now)
                old=c.execute('SELECT enabled,scope FROM social_profiles WHERE namespace=?',(namespace,)).fetchone()
                if old and old[1]!=scope:return {'ok':False,'code':'INVALID_SCOPE'}
                if not old and c.execute('SELECT COUNT(*) FROM social_profiles').fetchone()[0]>=MAX_SOCIAL_NAMESPACES:
                    return {'ok':False,'code':'SOCIAL_MEMORY_FULL'}
                enabled = int(action=='on') if action!='clear' else (old[0] if old else 1)
                c.execute('INSERT OR REPLACE INTO social_profiles VALUES(?,?,?,0,0,0,?)',(namespace,scope,enabled,now))
                for table in ('social_events','social_media','social_seen','social_traits','memories'):
                    c.execute(f'DELETE FROM {table} WHERE namespace=?',(namespace,))
            return {'ok':True,'disabled':not bool(enabled)}
        finally:c.close()


class SocialRecallArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    view: Literal['context']='context'


def build_social_tool(store, namespace, scope):
    @tool('recall_social_context',args_schema=SocialRecallArgs)
    def recall(view: str='context') -> dict:
        """回忆当前成员在当前对话的沟通习惯、明确表达的近期心情与媒体摘要；情绪会衰减，不是性格或诊断。"""
        return store.recall(namespace,scope)
    return recall
