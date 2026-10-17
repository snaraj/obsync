"""Owned isolated-emulator TCP route; no runtime read fallback/retry."""
import hashlib,ipaddress,json,os,re,shlex,socket,stat,subprocess,time
from pathlib import Path

def remaining(end):
 value=end-time.monotonic()
 if value<=0:raise TimeoutError('owned TCP attachment deadline')
 return min(3,value)

FRAMEWORK_PROVISIONING={
 ('shell','svc','wifi','enable'),
 ('shell','cmd','wifi','connect-network','AndroidWifi','open'),
 ('shell','settings','get','global','mobile_data'),
 ('shell','settings','put','global','mobile_data','0'),
 ('shell','svc','data','disable'),
}

def command(state,env,target,args,end,cap=3,binary=False):
 remaining(end)
 if cap not in (3,12,30) or (cap==12 and (target is not None or len(args)!=2 or args[0]!='connect' or not re.fullmatch(r'127\.0\.0\.1:[0-9]{4,5}',args[1]))):raise ValueError('connect-only command budget required')
 if cap==30:
  expected=state['serial'] if tuple(args) in (('shell','svc','wifi','enable'),('shell','cmd','wifi','connect-network','AndroidWifi','open')) else f"127.0.0.1:{state.get('ownedWifiTcpSetup',{}).get('hostPort')}"
  early_data=state.get('adbTransport')=='isolated-tcp' and state.get('selectedTcpAdb') is None and tuple(args) in (('shell','settings','get','global','mobile_data'),('shell','settings','put','global','mobile_data','0'),('shell','svc','data','disable')) and target==state['serial']
  if binary or tuple(args) not in FRAMEWORK_PROVISIONING or target!=expected and not early_data:raise ValueError('owned framework provisioning budget required')
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

INCOMING_GUEST_SCRIPT=GUEST_SCRIPT+"""grep '^Uid:' "/proc/$pid/status"
printf 'OBSYNC_INCOMING_GUEST_COMPLETE\\n'
"""

def incoming_guest(state,env,target,end):
 raw=command(state,env,target,['shell','sh','-c',shlex.quote(INCOMING_GUEST_SCRIPT)],end,binary=True)
 lines=raw.splitlines(keepends=True)
 if len(lines)!=6 or lines[-1]!=b'OBSYNC_INCOMING_GUEST_COMPLETE\n':raise ValueError('incoming_guest_framing')
 return {'guest':identity(b''.join(lines[:4])),'adbdUid':adbd_uid(lines[4]),'stdoutBytes':len(raw),'stdoutSha256':sha(raw),'framing':'COMPLETE_GUEST_AND_BOUND_UID'}

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
 return result

def save_binding(state,run,port,facts,phase,save,original,route_proof=None):
 q=state['processes']['emulator'];old=state.get('selectedTcpAdb');binding={'schema':1,'target':f'127.0.0.1:{port}','hostPort':port,'guestPort':5555,'emulatorSerial':state['serial'],'emulatorPid':q['pid'],'emulatorIdentity':q['identity'],'guest':facts}
 state['selectedTcpAdb']=binding;save(run/'android.json',state)
 save(run/'evidence'/f'owned-tcp-adb-{phase}-{time.time_ns()}.json',{'schema':1,'sourceHead':state['sourceHead'],'evidenceClass':'DIAGNOSTIC_ONLY','phase':phase,'target':binding['target'],'originalSerial':state['serial'],'guest':facts,'originalRouteGuest':original,'selectedRouteGuest':facts,'priorGuest':old['guest'] if old else None,'emulatorPid':q['pid'],'loopbackListenerOwned':True,'sameGuestIndependentCommands':True,'authConfigurationUnchanged':True,'adbAuthPosture':'PREEXISTING_USERDEBUG_UNCHANGED_NOT_RSA_AUTH_PROOF','responseRouteProof':route_proof})

def phone_service_state(raw):
 if raw==b'Service phone: found\n':return 'FOUND'
 if raw==b'Service phone: not found\n':return 'MISSING'
 raise ValueError('phone_service_check_unknown')

def wait_phone_service(read,end,proof,now=time.monotonic,pause=time.sleep):
 facts={'method':'READ_ONLY_SERVICE_CHECK_PHONE','polls':0,'first':None,'last':None,'ready':False,'perCallCapMs':3000,'deadline':'EXISTING_INITIAL_BOOT_DEADLINE'};proof['phoneServiceReadiness']=facts
 while now()<end:
  value=phone_service_state(read());facts['polls']+=1;facts['last']=value
  if facts['first'] is None:facts['first']=value
  if now()>=end:raise TimeoutError('phone_service_readiness_deadline')
  if value=='FOUND':facts['ready']=True;return
  pause(min(.3,end-now()))
 raise TimeoutError('phone_service_readiness_deadline')

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
  data_value=observe('observe_mobile_data_before_provisioning',state['serial'],['shell','settings','get','global','mobile_data'],cap=30);proof['dataBeforeProvisioningZero']=data_value=='0';proof['dataBeforeProvisioningValueClass']={'0':'ZERO','1':'ONE','null':'NULL','':'EMPTY'}.get(data_value,'OTHER')
  observe('prescribed_owned_guest_data_setting',state['serial'],['shell','settings','put','global','mobile_data','0'],cap=30)
  wait_phone_service(lambda:observe('required_phone_service_readiness',state['serial'],['shell','service','check','phone'],binary=True),end,proof)
  observe('prescribed_data_disable_before_wifi_routing',state['serial'],['shell','svc','data','disable'],cap=30)
  data_value=observe('verify_mobile_data_before_wifi_routing',state['serial'],['shell','settings','get','global','mobile_data'],cap=30);proof['mobileDataZeroBeforeWifiRouting']=data_value=='0';proof['dataBeforeWifiRoutingValueClass']={'0':'ZERO','1':'ONE','null':'NULL','':'EMPTY'}.get(data_value,'OTHER')
  if not proof['mobileDataZeroBeforeWifiRouting']:raise ValueError('owned early data disable not observed')
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
  proof['initialSyntheticWifi']=known_synthetic_wifi(observe('verify_known_synthetic_wifi_before_reboot',target,['shell','cmd','wifi','status']).encode())
  if not proof['initialSyntheticWifi']['exactKnownNetworkConnected']:raise ValueError('initial known synthetic Wi-Fi not established')
  state['rebootWifiRestoration']={'method':WIFI_RESTORATION_METHOD,'sourceHead':state['sourceHead'],'initialBootIdSha256':after['bootIdSha256'],'initialKnownNetworkConnected':True}
  proof['dummyProofPrivilege']='USERDEBUG_SU_READONLY_CHILD_SELINUX_PERMISSIVE_NOT_STOCK_SHELL'
  proof['dummyInterface']=dummy_link(observe('verify_dummy_link_kind',target,['shell','/system/xbin/su','0','/system/bin/ip','-d','link','show','dev','dummy0']).encode())
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

WIFI_RESTORATION_METHOD='ONE_KNOWN_SYNTHETIC_WIFI_CONNECT_AFTER_USER_UNLOCK'

def known_synthetic_wifi(raw):
 if len(raw)>16384:raise ValueError('wifi_status_budget')
 lines=raw.decode('utf-8',errors='strict').splitlines()
 enabled=lines.count('Wifi is enabled');disabled=lines.count('Wifi is disabled')
 connected=[line for line in lines if line.startswith('Wifi is connected to ')]
 known=connected in (['Wifi is connected to "AndroidWifi"'],['Wifi is connected to AndroidWifi'])
 return {'enabled':enabled==1 and disabled==0,'connectedRowCount':len(connected),'exactKnownNetworkConnected':enabled==1 and disabled==0 and known,'ssidValueExported':False}

def restore_known_wifi_once(state,env,end,prior,context,facts,failure_classifier):
 facts['stage']='reboot_wifi_restoration_declaration'
 declaration=state.get('rebootWifiRestoration',{})
 if declaration!={'method':WIFI_RESTORATION_METHOD,'sourceHead':state['sourceHead'],'initialBootIdSha256':prior['bootIdSha256'],'initialKnownNetworkConnected':True}:raise ValueError('predeclared initial synthetic Wi-Fi proof required')
 if context is None:raise ValueError('shared reboot restoration context required')
 proof=context.setdefault('restoration',{'method':WIFI_RESTORATION_METHOD,'sourceHead':state['sourceHead'],'initialBootIdSha256':declaration['initialBootIdSha256'],'priorBootIdSha256':prior['bootIdSha256'],'requestCount':0,'requestCapMs':30000,'result':'WAITING_FOR_USER_UNLOCK'})
 facts['wifiRestoration']=json.loads(json.dumps(proof))
 if proof['requestCount']:
  if proof['result']!='REQUEST_COMPLETED':raise ValueError('prior Wi-Fi restoration request failed')
  return True
 facts['stage']='wait_for_user0_unlock'
 try:
  value=command(state,env,state['serial'],['shell','am','get-started-user-state','0'],end)
  known=('BOOTING','RUNNING_LOCKED','RUNNING_UNLOCKING','RUNNING_UNLOCKED','STOPPING','SHUTDOWN')
  if value not in known:raise ValueError('user0 state unclassified')
  proof['userState']=value
  if value!='RUNNING_UNLOCKED':facts['pendingReason']='USER0_NOT_UNLOCKED';return False
  facts['stage']='reboot_wifi_restoration_request';proof.update(requestCount=1,result='REQUEST_STARTED',startedAtEpochMs=round(time.time()*1000),remainingPhaseBudgetBeforeRequestMs=int((end-time.monotonic())*1000));started=time.monotonic()
  try:response=command(state,env,state['serial'],['shell','cmd','wifi','connect-network','AndroidWifi','open'],end,cap=30)
  finally:proof['requestElapsedMs']=round((time.monotonic()-started)*1000)
  proof['responseClass']={'':'EMPTY','Connection initiated':'INITIATED','Connection failed':'REFUSED'}.get(response,'OTHER')
  if proof['responseClass'] not in ('EMPTY','INITIATED'):raise ValueError('known synthetic Wi-Fi request refused')
  remaining(end);proof['result']='REQUEST_COMPLETED';proof['connectionEstablishedByResponse']=False
  return True
 except Exception as error:
  proof.update(result='FAILED',failureStage=facts['stage'],exceptionType=type(error).__name__ if isinstance(error,(OSError,subprocess.SubprocessError,ValueError,TimeoutError)) else 'UNCLASSIFIED')
  if failure_classifier is not None and isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):proof['commandFailure']=failure_classifier(error)
  # The existing expected-attachment loop catches subprocess errors. A failed
  # prescribed Wi-Fi command must instead remain terminal and never resubmit.
  raise ValueError('prescribed Wi-Fi restoration failed') from error
 finally:facts['wifiRestoration']=json.loads(json.dumps(proof))

def reattach(state,run,env,end,phase,save,observe=None,failure_classifier=None,restoration_context=None):
 facts={'stage':'binding_validation','result':'PENDING','startedAtEpochMs':round(time.time()*1000),'priorGuest':state.get('selectedTcpAdb',{}).get('guest')};started=time.monotonic()
 def boot_value(value):return {'valueClass':'ONE' if value=='1' else 'ZERO' if value=='0' else 'EMPTY' if value=='' else 'OTHER','stdoutBytes':len(value.encode()),'stdoutSha256':sha(value.encode())}
 try:
  if phase not in ('root','reboot'):raise ValueError('only expected lifecycle attachment allowed')
  target=selected(state);port=state['selectedTcpAdb']['hostPort'];prior=state['selectedTcpAdb']['guest']
  facts['stage']='owned_listener';owned_listener=listener(state,port,end)
  facts['stage']='original_guest_identity';original=guest(state,env,state['serial'],end);facts['originalGuest']=original
  if phase=='reboot' and original['bootIdSha256']==prior['bootIdSha256']:facts['pendingReason']='ORIGINAL_BOOT_UNCHANGED';return False
  facts['stage']='original_boot_completed'
  if phase=='reboot':
   value=command(state,env,state['serial'],['shell','getprop','sys.boot_completed'],end);facts['originalBootCompleted']=boot_value(value)
   if value!='1':facts['pendingReason']='ORIGINAL_BOOT_NOT_COMPLETED';return False
  if phase=='reboot' and not restore_known_wifi_once(state,env,end,prior,restoration_context,facts,failure_classifier):return False
  route_proof={};facts['routeProof']=route_proof
  def route_read(stage,args):facts['stage']=stage;return command(state,env,state['serial'],args,end,binary=True)
  if phase=='root':response_route_ready(state,env,state['serial'],original,end,route_proof,read=route_read)
  else:
   setup=state.get('ownedWifiTcpSetup',{})
   if setup!={'hostPort':port,'radioOptions':'restrict=on','wifiOptions':f'restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:{port}-10.0.2.16:5555'}:raise ValueError('reboot Wi-Fi backend binding changed')
   route_proof.update(method='INCOMING_TCP_SAME_GUEST',listener=owned_listener,wifiBackend=setup.copy(),connectCapMs=12000,remainingPhaseBudgetBeforeConnectMs=int((end-time.monotonic())*1000))
  facts['stage']='selected_tcp_connect';connect_start=time.monotonic();response=connect(state,env,target,end,expected_transition=True);connect_elapsed=int((time.monotonic()-connect_start)*1000)
  if phase=='reboot' and response not in ('connected to '+target,'already connected to '+target):raise ValueError('reboot connect response missing')
  facts['stage']='selected_guest_identity'
  if phase=='reboot':
   exchange=incoming_guest(state,env,target,end);current=exchange['guest']
   route_proof.update(connectResponse=response,connectElapsedMs=connect_elapsed,incomingResponse=exchange,adbdUid=exchange['adbdUid'])
  else:current=guest(state,env,target,end)
  facts['selectedGuest']=current
  if original!=current or (phase=='root' and current['bootIdSha256']!=prior['bootIdSha256']):raise ValueError('expected lifecycle TCP guest differs')
  if phase=='reboot' and current['bootIdSha256']==prior['bootIdSha256']:facts['pendingReason']='SELECTED_BOOT_UNCHANGED';return False
  facts['stage']='selected_boot_completed'
  if phase=='reboot':
   value=command(state,env,target,['shell','getprop','sys.boot_completed'],end);facts['selectedBootCompleted']=boot_value(value)
   if value!='1':facts['pendingReason']='SELECTED_BOOT_NOT_COMPLETED';return False
  facts['stage']='root_uid'
  if phase=='root' and command(state,env,target,['shell','id','-u'],end)!='0':facts['pendingReason']='ROOT_UID_NOT_ZERO';return False
  facts['stage']='save_binding';remaining(end)
  if phase=='reboot':route_proof.update(originalBootCompleted=facts['originalBootCompleted'],selectedBootCompleted=facts['selectedBootCompleted'],phaseDeadlineMet=True,remainingPhaseBudgetBeforeSaveMs=int((end-time.monotonic())*1000))
  save_binding(state,run,port,current,phase,save,original,route_proof);remaining(end)
  facts.update(stage='attached',result='ATTACHED');return True
 except BaseException as error:
  facts.update(result='ERROR',exceptionType=type(error).__name__ if isinstance(error,(OSError,subprocess.SubprocessError,ValueError,TimeoutError,ExpectedAttachmentPending)) else 'UNCLASSIFIED')
  if isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)) and failure_classifier is not None:facts['commandFailure']=failure_classifier(error)
  raise
 finally:
  facts['elapsedMs']=round((time.monotonic()-started)*1000)
  if observe is not None:observe(facts)

REBOOT_REQUEST_METHOD='BOUND_ORIGINAL_EMULATOR_AFTER_SCOPED_TCP_DISCONNECT'

def request_reboot(state,run,env,end,save,require_owned):
 """One predeclared lifecycle request; failed commands never select another route."""
 started=time.monotonic();proof={'schema':1,'sourceHead':state['sourceHead'],'result':'FAIL','scope':'REBOOT_REQUEST_NOT_REBOOT_PROOF','method':REBOOT_REQUEST_METHOD,'stage':'declaration','requestCount':0,'disconnectCount':0,'requestCapMs':30000,'startedAtEpochMs':round(time.time()*1000)}
 try:
  remaining(end)
  if state.get('adbTransport')!='isolated-tcp' or state.get('rebootRequestMethod')!=REBOOT_REQUEST_METHOD:raise ValueError('explicit owned reboot request method required')
  target=selected(state);proof.update(originalSerial=state['serial'],selectedTcpTarget=target,emulatorPid=state['processes']['emulator']['pid'])
  def owned():
   fresh=require_owned()
   if any(fresh.get(key)!=state.get(key) for key in ('sourceHead','serial','adbTransport','rebootRequestMethod','selectedTcpAdb')) or fresh['processes']['emulator']!=state['processes']['emulator']:raise ValueError('reboot ownership changed')
   remaining(end)
  owned();listener(state,state['selectedTcpAdb']['hostPort'],end)
  proof['stage']='independent_guest_binding';original=guest(state,env,state['serial'],end);tcp=guest(state,env,target,end)
  if original!=tcp or tcp!=state['selectedTcpAdb']['guest']:raise ValueError('reboot request guest differs')
  proof.update(originalRouteGuest=original,selectedRouteGuest=tcp,matchedRetainedGuest=True)
  proof['stage']='scoped_tcp_disconnect';proof['disconnectCount']=1
  if command(state,env,None,['disconnect',target],end)!='disconnected '+target:raise ValueError('scoped disconnect not confirmed')
  proof['stage']='scoped_tcp_transport_removed'
  if command(state,env,target,['wait-for-disconnect'],end)!='':raise ValueError('scoped transport removal not confirmed')
  proof['selectedTransportRemoved']=True
  owned();listener(state,state['selectedTcpAdb']['hostPort'],end)
  if guest(state,env,state['serial'],end)!=original:raise ValueError('reboot request original guest changed')
  owned()
  proof['stage']='original_emulator_reboot_request';remaining(end);request_end=min(end,time.monotonic()+30);proof['remainingPhaseBudgetBeforeRequestMs']=round((end-time.monotonic())*1000);proof['requestCount']=1;request_started=time.monotonic()
  argv=[str(Path(state['sdk'])/'platform-tools/adb'),'-P',str(state['adbPort']),'-s',state['serial'],'reboot']
  try:
   result=subprocess.run(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=max(.001,request_end-time.monotonic()))
   remaining(request_end);proof.update(requestExitCode=result.returncode,stdoutBytes=len(result.stdout),stderrBytes=len(result.stderr))
   if result.stdout or result.stderr:raise ValueError('unexpected reboot request response')
  finally:proof['requestElapsedMs']=int((time.monotonic()-request_started)*1000)
  proof.update(result='PASS',stage='request_completed')
 except BaseException as error:
  proof['failure']={'stage':proof['stage'],'exceptionType':type(error).__name__ if isinstance(error,(OSError,subprocess.SubprocessError,ValueError,TimeoutError)) else 'UNCLASSIFIED'}
  if isinstance(error,subprocess.CalledProcessError):proof['requestExitCode']=error.returncode
  if isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):
   proof['failure'].update(stdoutBytes=len(error.output or b''),stderrBytes=len(error.stderr or b''))
  raise
 finally:
  proof['elapsedMs']=round((time.monotonic()-started)*1000);save(run/'evidence/owned-tcp-reboot-request.json',proof)
 remaining(end)
 return proof
