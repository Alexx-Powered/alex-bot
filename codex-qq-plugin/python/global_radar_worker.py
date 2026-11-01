import contextlib
import io
import sys
from pathlib import Path
from agent_worker import read_packet,write_packet
from global_radar import build_global_radar_tool

tool=build_global_radar_tool(Path.cwd()/'.private')
while True:
    packet=read_packet(sys.stdin.buffer)
    if packet is None:break
    result={'type':'result','id':packet.get('id'),'kind':'analysis'}
    try:
        if packet.get('type')!='global_radar':raise ValueError()
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            result['data']=tool.invoke(packet.get('args',{}))
    except Exception:result['data']={'ok':False,'code':'GLOBAL_RADAR_SOURCE_UNAVAILABLE'}
    write_packet(sys.stdout.buffer,result)
