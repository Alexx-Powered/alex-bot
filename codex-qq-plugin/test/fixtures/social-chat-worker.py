"""Offline integration fixture: real graph and memory, scripted model, no network."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'python'))
from agent_worker import build_runner,read_packet,write_packet
from chat_memory import ChatMemoryStore
from test_agent_worker import ScriptedModel,call

current={}
def factory(_):
    media=current.get('context',{}).get('media',{})
    text='这猫抱着饭碗不撒手，跟鱼抢饭是吧~' if '猫' in media.get('description','') else '鱼还没看见图~'
    return ScriptedModel(responses=[call('reply_chat',{'topic':'群聊闲聊','topic_relation':'continue','reply_tone':'playful','text':text})])
runner=build_runner(model_factory=factory,memory_store=ChatMemoryStore(Path.cwd()/'.private/chat-memory'))
while True:
    p=read_packet(sys.stdin.buffer)
    if p is None:break
    current=p
    write_packet(sys.stdout.buffer,runner.run(p))
