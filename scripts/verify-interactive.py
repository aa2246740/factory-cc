import pexpect, json, sys, os, time, signal, re

def atomic_json(path, value):
 temp = path + '.tmp'
 with open(temp, 'w') as handle: json.dump(value, handle, indent=2)
 os.replace(temp, path)

private, evidence, actions = sys.argv[1:]
cfg=json.load(open(private))
env=os.environ.copy(); env.update(cfg['env']); env['TERM']='xterm-256color'
child=pexpect.spawn(cfg['command'][0],cfg['command'][1:],env=env,cwd=cfg['cwd'],encoding='utf-8',codec_errors='replace',dimensions=(42,132),timeout=1)
raw=open(evidence+'/terminal.raw.txt','w'); child.logfile_read=raw
transcript=''; done=0; reports=[]
try:
 while child.isalive():
  try:
   piece=child.read_nonblocking(100000,timeout=0.3); transcript+=piece
   if '\x1b[6n' in piece: child.send('\x1b[1;1R')
   if '\x1b[c' in piece: child.send('\x1b[?1;2c')
   raw.flush()
  except pexpect.TIMEOUT: pass
  except pexpect.EOF: break
  lines=open(actions).read().splitlines() if os.path.exists(actions) else []
  for line in lines[done:]:
   action=json.loads(line); reports.append({'at':time.time(),'action':action})
   if 'send' in action: child.send(action['send'])
   if 'signal' in action: child.kill(getattr(signal,action['signal']))
   done+=1
  clean=re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)','',transcript)
  clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',clean)
  open(evidence+'/terminal.txt','w').write(clean)
  atomic_json(evidence+'/pty-state.json', {'pid':child.pid,'actions':reports,'alive':child.isalive()})
 child.close()
finally:
 if child.isalive(): child.terminate(force=True)
 raw.close()
 atomic_json(evidence+'/pty-state.json', {'pid':child.pid,'exitStatus':child.exitstatus,'signalStatus':child.signalstatus,'actions':reports,'alive':child.isalive()})
