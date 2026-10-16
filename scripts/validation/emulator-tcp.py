"""Owned isolated-emulator TCP route; no runtime read fallback/retry."""
import hashlib,ipaddress,json,os,re,shlex,socket,stat,subprocess,time
from pathlib import Path

def remaining(end):
 value=end-time.monotonic()
 if value<=0:raise TimeoutError('owned TCP attachment deadline')
 return min(3,value)

FRAMEWORK_PROVISIONING={
 ('shell','svc','wifi','enable'),
 ('shell','settings','get','global','mobile_data'),
 ('shell','settings','put','global','mobile_data','0'),
 ('shell','svc','data','disable'),
}

def command(state,env,target,args,end,cap=3,binary=False):
 remaining(end)
 if cap not in (3,12,30) or (cap==12 and (target is not None or len(args)!=2 or args[0]!='connect' or not re.fullmatch(r'127\.0\.0\.1:[0-9]{4,5}',args[1]))):raise ValueError('connect-only command budget required')
 if cap==30:
  expected=state['serial'] if tuple(args)==('shell','svc','wifi','enable') else f"127.0.0.1:{state.get('ownedWifiTcpSetup',{}).get('hostPort')}"
  if binary or tuple(args) not in FRAMEWORK_PROVISIONING or target!=expected:raise ValueError('owned framework provisioning budget required')
 operation_end=min(end,time.monotonic()+cap)
 argv=[str(Path(state['sdk'])/'platform-tools/adb'),'-P',str(state['adbPort'])]
 if target is not None:argv+=['-s',target]
 value=subprocess.check_output(argv+args,env=env,stderr=subprocess.PIPE,timeout=max(.001,operation_end-time.monotonic()),text=not binary)
 remaining(operation_end)
 if len(value if binary else value.encode())>16384:raise ValueError('owned TCP metadata output budget')
 if not binary:value=value.strip()
 return value

GUEST_SCRIPT='''set -eu
boot=$(cat /proc/sys/kernel/random/boot_id)
pid=$(pidof adbd)
case "$pid" in ''|*[!0-9]*) exit 2;; esac
printf '%s\\n%s\\n' "$boot" "$pid"
cat "/proc/$pid/stat"
printf 'OBSYNC_GUEST_IDENTITY_COMPLETE\\n'
'''

def sha(data):return hashlib.sha256(data).hexdigest()

def identity(data):
 lines=data.decode('utf-8',errors='strict').splitlines()
 if len(lines)!=4 or lines[-1]!='OBSYNC_GUEST_IDENTITY_COMPLETE' or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',lines[0]) or not re.fullmatch('[0-9]+',lines[1]) or int(lines[1])<=1:raise ValueError('guest_identity_framing')
 if not lines[2].startswith(lines[1]+' (adbd) '):raise ValueError('adbd_identity_differs')
 fields=lines[2].rsplit(')',1)[-1].split()
 if len(fields)<20 or not fields[19].isdecimal():raise ValueError('adbd_start_invalid')
 return {'bootIdSha256':sha(lines[0].encode()),'adbdPid':int(lines[1]),'adbdStartTicks':fields[19]}

def network(addresses,routes,listeners):
 if any(len(value)>16384 for value in (addresses,routes,listeners)):raise ValueError('network_observation_budget')
 result={'addresses':[],'routes':[],'tcp5555Listeners':[]}
 for line in addresses.decode('utf-8',errors='strict').splitlines():
  m=re.match(r'^\d+: (eth0|wlan0)(?:@[^ ]+)?\s+inet\s+([0-9./]+)\s',line)
  if m:result['addresses'].append({'interface':m[1],'address':str(ipaddress.IPv4Interface(m[2]))})
  elif re.match(r'^\d+: (eth0|wlan0)(?:@[^ ]+)?(?:\s|:)',line):raise ValueError('guest_ipv4_format')
 for line in routes.decode('utf-8',errors='strict').splitlines():
  tokens=line.split()
  if 'dev' not in tokens:continue
  interface=tokens[tokens.index('dev')+1]
  if interface not in ('eth0','wlan0'):continue
  route_kind=tokens.pop(0) if tokens[0] in ('local','broadcast','unicast','unreachable','throw') else 'unicast'
  dest=tokens[0];row={'interface':interface,'kind':route_kind,'destination':'default' if dest=='default' else str(ipaddress.IPv4Network(dest,strict=False))}
  for field in ('via','src'):
   if field in tokens:row[field]=str(ipaddress.IPv4Address(tokens[tokens.index(field)+1]))
  result['routes'].append(row)
 for line in listeners.decode('utf-8',errors='strict').splitlines():
  fields=line.split()
  if len(fields)>=6 and fields[0] in ('tcp','tcp6') and fields[5]=='LISTEN' and fields[3].rsplit(':',1)[-1]=='5555':
   local=fields[3].rsplit(':',1)[0].strip('[]');result['tcp5555Listeners'].append({'protocol':fields[0],'address':str(ipaddress.ip_address(local)),'port':5555})
 if len(result['addresses'])>8 or len(result['routes'])>64 or len(result['tcp5555Listeners'])>4:raise ValueError('network_observation_count')
 return result

def listener_facts(raw,expected_pid,port):
 facts={'processRecords':0,'descriptorRecords':0,'addressRecords':0,'unknownFields':0,'onlyExpectedPid':False,'onlyExpectedLoopbackAddress':False,'ready':False}
 if len(raw)>8192:facts['parseFailure']='OUTPUT_BUDGET';return facts
 try:lines=raw.decode('utf-8',errors='strict').splitlines()
 except UnicodeError:facts['parseFailure']='UTF8';return facts
 pids=[];fds=[];names=[]
 for line in lines:
  if re.fullmatch(r'p[0-9]+',line):pids.append(int(line[1:]))
  elif re.fullmatch(r'f[0-9]+',line):fds.append(int(line[1:]))
  elif line.startswith('n'):names.append(line[1:])
  else:facts['unknownFields']+=1
 facts.update(processRecords=len(pids),descriptorRecords=len(fds),addressRecords=len(names),onlyExpectedPid=pids==[expected_pid],onlyExpectedLoopbackAddress=names==[f'127.0.0.1:{port}'])
 facts['ready']=facts['onlyExpectedPid'] and facts['onlyExpectedLoopbackAddress'] and len(fds)==1 and facts['unknownFields']==0
 return facts

def wait_guest_addresses(read,initial,end,proof,now=time.monotonic,pause=time.sleep):
 facts={'first':initial,'last':initial,'polls':1,'ready':False};proof['guestAddressReadiness']=facts
 while True:
  if now()>=end:raise TimeoutError('guest_ipv4_readiness_deadline')
  if any(item['interface']=='wlan0' and ipaddress.IPv4Interface(item['address']).ip==ipaddress.IPv4Address('10.0.2.16') for item in facts['last']):
   facts['ready']=True;return facts['last']
  pause(min(.3,max(0,end-now())))
  if now()>=end:raise TimeoutError('guest_ipv4_readiness_deadline')
  facts['last']=read();facts['polls']+=1

def effective_network_options(raw,radio,wifi):
 if len(raw)>16*1024*1024:return {'ready':False,'reason':'LOG_BUDGET'}
 arguments=re.findall(rb'\bargv\[\s*[0-9]+\s*\]\s*=\s*"([^"\r\n]*)"',raw)
 counts=[arguments.count(value.encode()) for value in (radio,wifi)]
 return {'ready':counts==[1,1],'radioArgumentMatches':counts[0],'wifiArgumentMatches':counts[1],'expectedRadioArgument':radio,'expectedWifiArgument':wifi,'rawInitLogExported':False,'nativeIsolationTrafficProof':'NOT_MEASURED'}

def guest(state,env,target,end):
 return identity(command(state,env,target,['shell','sh','-c',shlex.quote(GUEST_SCRIPT)],end).encode())

def listener(state,port,end):
 r=subprocess.run(['/usr/sbin/lsof','-nP','-iTCP:'+str(port),'-sTCP:LISTEN','-Fpn'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=remaining(end))
 remaining(end)
 facts=listener_facts(r.stdout,state['processes']['emulator']['pid'],port)
 if r.returncode or r.stderr or not facts['ready']:raise ValueError('owned TCP listener not exclusive loopback QEMU')
 return {'pid':state['processes']['emulator']['pid'],'address':f'127.0.0.1:{port}',**facts}

def dummy_link(raw):
 if len(raw)>4096:raise ValueError('dummy_link_unknown')
 text=raw.decode('utf-8',errors='strict')
 headers=re.findall(r'(?m)^([0-9]+): dummy0(?:@NONE)?: ',text)
 is_dummy=bool(re.search(r'(?m)^\s+dummy(?:\s|$)',text))
 if len(headers)!=1 or int(headers[0])<=0 or not is_dummy:raise ValueError('dummy_link_unknown')
 return {'interface':'dummy0','index':int(headers[0]),'kind':'dummy','routeTable':1000+int(headers[0])}

def egress_routes(raw,dummy=None):
 if len(raw)>16384:raise ValueError('route_observation_budget')
 extra=0;defaults=0;interfaces={};discard_routes=0
 for line in raw.decode('utf-8',errors='strict').splitlines():
  fields=line.split()
  if not fields or fields[0] in ('unreachable','prohibit','blackhole','throw'):continue
  if 'dev' not in fields:raise ValueError('route_shape_unknown')
  dev=fields[fields.index('dev')+1]
  if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,32}',dev):raise ValueError('route_shape_unknown')
  interfaces[dev]=interfaces.get(dev,0)+1
  if dev=='dummy0' and dummy is not None:
   expected={f'default dev dummy0 table {table} proto static scope link' for table in (dummy['routeTable'],'dummy0')}
   if line.strip() not in expected:raise ValueError('dummy_route_unknown')
   discard_routes+=1
   if discard_routes>1:raise ValueError('dummy_route_unknown')
  elif dev not in ('lo','wlan0'):extra+=1
  if fields[0]=='default':defaults+=1
 return {'extraEgressRoutes':extra,'defaultRouteCount':defaults,'allowedInterfaces':['lo','wlan0'],'observedInterfaceCounts':interfaces,'verifiedDiscardRoutes':discard_routes}

def adbd_uid(raw):
 if len(raw)>16384:raise ValueError('adbd_uid_unknown')
 matches=re.findall(rb'(?m)^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$',raw)
 if len(matches)!=1 or len(set(matches[0]))!=1:raise ValueError('adbd_uid_unknown')
 return int(matches[0][0])

def route_lookup(raw,uid):
 if len(raw)>4096:raise ValueError('route_lookup_unknown')
 match=re.search(rb'\nOBSYNC_ROUTE_EXIT=([0-9]+)\nOBSYNC_ROUTE_DONE\n$',raw)
 if match is None:raise ValueError('route_lookup_unknown')
 body=raw[:match.start()].decode('utf-8',errors='strict').strip();code=int(match[1])
 if code==2 and body=='RTNETLINK answers: Network is unreachable':return {'ready':False,'state':'NO_ROUTE','uid':uid}
 if code!=0:raise ValueError('route_lookup_unknown')
 lines=body.splitlines()
 if not lines or len(lines)>2 or (len(lines)==2 and lines[1].strip()!='cache'):raise ValueError('route_lookup_unknown')
 fields=lines[0].split();expected={'from':'10.0.2.16','uid':str(uid)}
 if not fields or fields[0]!='10.0.2.2' or len(fields)%2!=1:raise ValueError('route_lookup_unknown')
 pairs=dict(zip(fields[1::2],fields[2::2]))
 if len(pairs)!=(len(fields)-1)//2 or set(pairs)-{'from','dev','table','uid','src'} or any(pairs.get(k)!=v for k,v in expected.items()) or pairs.get('dev') not in ('wlan0','dummy0') or ('src' in pairs and pairs['src']!='10.0.2.16'):raise ValueError('route_lookup_unknown')
 if 'table' in pairs and not (pairs['table'].isdigit() or pairs['table'] in ('wlan0','dummy0')):raise ValueError('route_lookup_unknown')
 return {'ready':pairs['dev']=='wlan0','state':'WLAN0_ROUTE' if pairs['dev']=='wlan0' else 'DUMMY_ROUTE','uid':uid,'interface':pairs['dev'],'from':'10.0.2.16','table':pairs.get('table')}

def wait_route(read,end,proof,now=time.monotonic,pause=time.sleep):
 facts={'first':None,'last':None,'polls':0,'ready':False};proof['guestResponseRouteReadiness']=facts
 while now()<end:
  value=read();facts['polls']+=1;facts['last']=value
  if facts['first'] is None:facts['first']=value
  if now()>=end:raise TimeoutError('response_route_readiness_deadline')
  if value['ready']:facts['ready']=True;return
  pause(min(.3,end-now()))
 raise TimeoutError('response_route_readiness_deadline')

def response_route_ready(state,env,target,bound_guest,end,proof,read=None):
 # Sample the current bound adbd UID on each initial/root/reboot phase.
 if read is None:read=lambda stage,args:command(state,env,target,args,end,binary=True)
 proof['adbdUid']=adbd_uid(read('read_bound_adbd_uid',['shell','cat',f'/proc/{bound_guest["adbdPid"]}/status']))
 def query():
  script=f'ip -4 route get 10.0.2.2 from 10.0.2.16 uid {proof["adbdUid"]} mark 0 2>&1; code=$?; printf "\\nOBSYNC_ROUTE_EXIT=%s\\nOBSYNC_ROUTE_DONE\\n" "$code"'
  return route_lookup(read('guest_response_route_readiness',['shell','sh','-c',shlex.quote(script)]),proof['adbdUid'])
 wait_route(query,end,proof)

def prepare(state):
 if state.get('selectedTcpAdb') is not None or state.get('ownedWifiTcpSetup') is not None:raise ValueError('owned Wi-Fi route already prepared')
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 wifi=f'restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:{port}-10.0.2.16:5555'
 state['ownedWifiTcpSetup']={'hostPort':port,'wifiOptions':wifi,'radioOptions':'restrict=on'}
 return ['-feature','-WiFiPacketStream','-network-user-mode-options','restrict=on','-wifi-user-mode-options',wifi]

def selected(state):
 b=state.get('selectedTcpAdb');q=state['processes']['emulator']
 if not isinstance(b,dict) or b.get('schema')!=1 or b.get('emulatorSerial')!=state['serial'] or b.get('emulatorPid')!=q['pid'] or b.get('emulatorIdentity')!=q['identity']:raise ValueError('selected owned TCP binding required')
 port=b.get('hostPort');target=f'127.0.0.1:{port}'
 if type(port) is not int or not 1024<=port<=65535 or b.get('target')!=target or b.get('guestPort')!=5555 or not re.fullmatch('[a-f0-9]{64}',b.get('guest',{}).get('bootIdSha256','')) or type(b.get('guest',{}).get('adbdPid')) is not int or b['guest']['adbdPid']<=1 or not str(b['guest'].get('adbdStartTicks','')).isdecimal():raise ValueError('selected owned TCP binding invalid')
 return target

class ExpectedAttachmentPending(Exception):pass

def connect(state,env,target,end,expected_transition=False):
 result=command(state,env,None,['connect',target],end,cap=12)
 if expected_transition and result in (f"failed to connect to '{target}': Connection refused",'failed to connect to '+target):raise ExpectedAttachmentPending('expected owned TCP restart not ready')
 if result not in ('connected to '+target,'already connected to '+target):raise ValueError('owned TCP connect not confirmed')

def save_binding(state,run,port,facts,phase,save,original,route_proof=None):
 q=state['processes']['emulator'];old=state.get('selectedTcpAdb');binding={'schema':1,'target':f'127.0.0.1:{port}','hostPort':port,'guestPort':5555,'emulatorSerial':state['serial'],'emulatorPid':q['pid'],'emulatorIdentity':q['identity'],'guest':facts}
 state['selectedTcpAdb']=binding;save(run/'android.json',state)
 save(run/'evidence'/f'owned-tcp-adb-{phase}-{time.time_ns()}.json',{'schema':1,'sourceHead':state['sourceHead'],'evidenceClass':'DIAGNOSTIC_ONLY','phase':phase,'target':binding['target'],'originalSerial':state['serial'],'guest':facts,'originalRouteGuest':original,'selectedRouteGuest':facts,'priorGuest':old['guest'] if old else None,'emulatorPid':q['pid'],'loopbackListenerOwned':True,'sameGuestIndependentCommands':True,'authConfigurationUnchanged':True,'adbAuthPosture':'PREEXISTING_USERDEBUG_UNCHANGED_NOT_RSA_AUTH_PROOF','responseRouteProof':route_proof})

def initial(state,run,env,end,save,failure_classifier=None):
 if state.get('selectedTcpAdb') is not None:raise ValueError('TCP selection already performed')
 setup=state.get('ownedWifiTcpSetup',{});port=setup.get('hostPort')
 if type(port) is not int or not 1024<=port<=65535 or setup.get('radioOptions')!='restrict=on' or setup.get('wifiOptions')!=f'restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:{port}-10.0.2.16:5555':raise ValueError('predeclared owned Wi-Fi route required')
 proof={'schema':1,'sourceHead':state['sourceHead'],'evidenceClass':'DIAGNOSTIC_ONLY','result':'FAIL','stage':'effective_options','routeProvisioning':'EXPLICIT_WIFI_BACKEND_HOSTFWD','commands':[],'connectAttempts':0,'isolationTrafficProof':'NOT_MEASURED'}
 def observe(stage,target,args,cap=3,binary=False):
  proof['stage']=stage;entry={'stage':stage,'commandCapMs':cap*1000,'startedAtEpochMs':round(time.time()*1000),'startedAtMonotonicNs':time.monotonic_ns()};proof['commands'].append(entry)
  try:
   value=command(state,env,target,args,end,cap=cap,**({'binary':True} if binary else {}));raw=value if binary else value.encode();entry.update(stdoutBytes=len(raw),stdoutSha256=sha(raw));return value
  except BaseException as error:
   entry['exceptionType']=type(error).__name__
   if failure_classifier is not None and isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):entry['commandFailure']=failure_classifier(error)
   raise
  finally:entry['elapsedMs']=(time.monotonic_ns()-entry['startedAtMonotonicNs'])//1000000
 try:
  log=run/'private/emulator.log';info=log.lstat()
  if not stat.S_ISREG(info.st_mode) or log.is_symlink() or info.st_uid!=os.getuid() or info.st_size>16*1024*1024:raise ValueError('owned init log custody')
  proof['effectiveNetworkOptions']=effective_network_options(log.read_bytes(),'user,id=mynet,restrict=on','user,id=virtio-wifi,'+setup['wifiOptions'])
  if not proof['effectiveNetworkOptions']['ready']:raise ValueError('effective restricted backends not observed')
  observe('enable_only_owned_guest_wifi_once',state['serial'],['shell','svc','wifi','enable'],cap=30);proof['wifiEnableCount']=1
  def addresses():return network(observe('guest_ipv4_readiness',state['serial'],['shell','ip','-o','-4','addr','show']).encode(),b'',b'')['addresses']
  proof['guestAddresses']=wait_guest_addresses(addresses,addresses(),end,proof)
  before=guest(state,env,state['serial'],end);proof['originalRouteGuest']=before
  response_route_ready(state,env,state['serial'],before,end,proof,read=lambda stage,args:observe(stage,state['serial'],args,binary=True))
  proof['stage']='listener';proof['listener']=listener(state,port,end);target=f'127.0.0.1:{port}'
  proof['remainingBootBudgetBeforeConnectMs']=int((end-time.monotonic())*1000);proof['connectAttempts']=1
  response=observe('single_standard_tcp_connect',None,['connect',target],cap=12)
  if response not in ('connected to '+target,'already connected to '+target):raise ValueError('owned TCP connect not confirmed')
  proof['connectResponse']='CONNECTED' if response.startswith('connected to ') else 'ALREADY_CONNECTED'
  after=guest(state,env,target,end);proof['selectedRouteGuest']=after
  if before!=after:raise ValueError('redirected TCP guest differs from bootstrap')
  proof['dataBeforeProvisioningZero']=observe('observe_mobile_data_before_provisioning',target,['shell','settings','get','global','mobile_data'],cap=30)=='0'
  proof['dummyProofPrivilege']='USERDEBUG_SU_READONLY_CHILD_SELINUX_PERMISSIVE_NOT_STOCK_SHELL'
  proof['dummyInterface']=dummy_link(observe('verify_dummy_link_kind',target,['shell','/system/xbin/su','0','/system/bin/ip','-d','link','show','dev','dummy0']).encode())
  observe('prescribed_owned_guest_data_setting',target,['shell','settings','put','global','mobile_data','0'],cap=30)
  observe('prescribed_data_disable_after_tcp_binding',target,['shell','svc','data','disable'],cap=30)
  proof['mobileDataGlobalSettingZero']=observe('verify_mobile_data_disabled',target,['shell','settings','get','global','mobile_data'],cap=30)=='0'
  proof['ipv4RouteIsolation']=egress_routes(observe('verify_no_extra_ipv4_egress_routes',target,['shell','ip','-4','route','show','table','all']).encode(),proof['dummyInterface'])
  if not proof['mobileDataGlobalSettingZero'] or proof['ipv4RouteIsolation']['extraEgressRoutes']:raise ValueError('unexpected data or egress route')
  remaining(end);save_binding(state,run,port,after,'initial',save,before,{'adbdUid':proof['adbdUid'],'guestResponseRouteReadiness':proof['guestResponseRouteReadiness']});remaining(end)
  proof.update(result='OBSERVED',stage='complete',sameGuestTcpBinding=True,wifiNotDisabledAfterBinding=True)
 except BaseException as error:
  proof['failure']={'stage':proof['stage'],'exceptionType':type(error).__name__}
  if failure_classifier is not None and isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):proof['failure']['commandFailure']=failure_classifier(error)
  raise
 finally:save(run/'evidence/owned-wifi-route-initial.json',proof)

def reattach(state,run,env,end,phase,save):
 if phase not in ('root','reboot'):raise ValueError('only expected lifecycle attachment allowed')
 target=selected(state);port=state['selectedTcpAdb']['hostPort'];prior=state['selectedTcpAdb']['guest'];listener(state,port,end)
 original=guest(state,env,state['serial'],end)
 if phase=='reboot' and original['bootIdSha256']==prior['bootIdSha256']:return False
 if phase=='reboot' and command(state,env,state['serial'],['shell','getprop','sys.boot_completed'],end)!='1':return False
 route_proof={};response_route_ready(state,env,state['serial'],original,end,route_proof)
 connect(state,env,target,end,expected_transition=True)
 current=guest(state,env,target,end)
 if original!=current or (phase=='root' and current['bootIdSha256']!=prior['bootIdSha256']):raise ValueError('expected lifecycle TCP guest differs')
 if phase=='reboot' and current['bootIdSha256']==prior['bootIdSha256']:return False
 if phase=='reboot' and command(state,env,target,['shell','getprop','sys.boot_completed'],end)!='1':return False
 if phase=='root' and command(state,env,target,['shell','id','-u'],end)!='0':return False
 remaining(end)
 save_binding(state,run,port,current,phase,save,original,route_proof)
 remaining(end)
 return True
