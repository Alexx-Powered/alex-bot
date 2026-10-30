// Operator-only: key travels in a private stdin pipe, never argv, logs or output.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AgentConfigStore} from '../src/agent-config.mjs';
import {pythonEnvironment} from '../src/python-agent.mjs';
const config=await new AgentConfigStore('/var/lib/alexbot').read();
if(!config.enabled||!config.apiKey)throw Error('MODEL_NOT_CONFIGURED');
const child=spawn('/opt/alex-bot-runtime/python/app-venv/bin/python',['-B',fileURLToPath(new URL('./evaluate-social.py',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:pythonEnvironment(),cwd:'/var/lib/alexbot'});
child.stdin.end(JSON.stringify(config));child.stdout.pipe(process.stdout);child.stderr.resume();
const timer=setTimeout(()=>child.kill(),150000);
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code||0;});
