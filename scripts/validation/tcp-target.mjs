// Owned emulator target binding. Original emulator serial is never a fallback.
export function selectedTarget(state){
  const b=state.selectedTcpAdb,q=state.processes?.emulator,guest=b?.guest;
  if(!b||b.schema!==1||!q||b.emulatorSerial!==state.serial||b.emulatorPid!==q.pid||b.emulatorIdentity!==q.identity||!Number.isInteger(b.hostPort)||b.hostPort<1024||b.hostPort>65535||b.target!==`127.0.0.1:${b.hostPort}`||b.guestPort!==5555||!/^[a-f0-9]{64}$/.test(guest?.bootIdSha256??'')||!Number.isInteger(guest?.adbdPid)||guest.adbdPid<=1||typeof guest?.adbdStartTicks!=='string'||!/^\d+$/.test(guest.adbdStartTicks))throw Error('selected owned TCP binding required');
  return b.target;
}
export function verifyListener(state,text){
  selectedTarget(state);
  if(typeof text!=='string'||Buffer.byteLength(text)>8192)throw Error('owned TCP listener unavailable');
  const lines=text.split(/\r?\n/);if(lines.at(-1)==='')lines.pop();
  const pids=lines.filter(x=>/^p\d+$/.test(x)).map(x=>Number(x.slice(1))),fds=lines.filter(x=>/^f\d+$/.test(x)),addresses=lines.filter(x=>x.startsWith('n')).map(x=>x.slice(1));
  if(lines.some(x=>!/^p\d+$/.test(x)&&!/^f\d+$/.test(x)&&!x.startsWith('n'))||pids.length!==1||pids[0]!==state.processes.emulator.pid||fds.length!==1||addresses.length!==1||addresses[0]!==state.selectedTcpAdb.target)throw Error('owned TCP listener not exclusive loopback QEMU');
  return true;
}

export function emulatorTarget(state){
  const mode=state.adbTransport??'emulator';
  if(!['emulator','isolated-tcp'].includes(mode)||mode!=='isolated-tcp'&&state.selectedTcpAdb!=null)throw Error('explicit emulator transport differs from binding');
  return mode==='isolated-tcp'?selectedTarget(state):state.serial;
}
