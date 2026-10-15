"""Offline certificate correlation controls; never contacts a device."""
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('tls_proof',Path(__file__).with_name('android-tls-proof.py'))
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)


def row(at=100,pid=321,code=-202):
    return f'{at:.3f} {pid} 444 E chromium: [ERROR:ssl_client_socket_impl.cc(879)] handshake failed; net_error {code}\n'


class Correlation(unittest.TestCase):
    def test_exact_pid_time_code_and_anchor_required(self):
        anchor='100.100 321 444 W System.err: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.\n'
        self.assertEqual(M.correlated(row()+anchor,321,100,101,'untrusted')['expectedNetError'],-202)
        for log in (row(),row(pid=322)+anchor,row(at=98)+anchor,row(code=-200)+anchor,row()+row(code=-200)+anchor):
            with self.assertRaises(ValueError):M.correlated(log,321,100,101,'untrusted')
        self.assertEqual(M.correlated(row(code=-200),321,100,101,'wrong-host')['expectedNetError'],-200)

    def test_receipt_not_rewritten_log_never_persisted_and_pid_change_fails(self):
        with tempfile.TemporaryDirectory(prefix='obsync-tls-proof-') as tmp:
            run=Path(tmp).resolve();(run/'evidence').mkdir();probe=run/'evidence/probe.json';host=run/'host.json'
            now=time.time();iso=lambda n:__import__('datetime').datetime.fromtimestamp(n,__import__('datetime').timezone.utc).isoformat().replace('+00:00','Z')
            data={'sourceHead':'a'*40,'case':'untrusted','appPid':321,'webViewFetchResolved':False,
                  'tlsVerificationDisabled':False,'result':'FAIL','probeStartedAt':iso(now-1),'probeEndedAt':iso(now)}
            M.SESSION.save(probe,data);M.SESSION.save(host,{'result':'PASS','trustedHostReadinessStatus':200,'hostWrongHostnameRejected':True})
            original=probe.read_bytes();log=row(now)+f'{now:.3f} 321 444 E System.err: Trust anchor for certification path not found. SECRET-RAW\n'
            with patch.object(M.SESSION,'live_state',return_value={'sourceHead':'a'*40}),patch.object(M.SESSION,'app_pid',return_value=321),patch.object(M.SESSION,'adb_command',side_effect=[str(int(now)),log]):
                result=M.proof(run,probe,host,M.SESSION.digest(host))
            self.assertEqual(probe.read_bytes(),original)
            receipt=Path(result['receipt']).read_text();self.assertNotIn('SECRET-RAW',receipt);self.assertIn('untrustedRejected',receipt)
            with patch.object(M.SESSION,'live_state',return_value={'sourceHead':'a'*40}),patch.object(M.SESSION,'app_pid',side_effect=[321,322]),patch.object(M.SESSION,'adb_command',side_effect=[str(int(now)),log]):
                with self.assertRaisesRegex(ValueError,'PID changed'):M.proof(run,probe,host,M.SESSION.digest(host))
            for update in ({'webViewFetchResolved':True},{'tlsVerificationDisabled':True},{'sourceHead':'b'*40},{'probeStartedAt':iso(now-30)}):
                M.SESSION.save(probe,data|update)
                with patch.object(M.SESSION,'live_state',return_value={'sourceHead':'a'*40}),patch.object(M.SESSION,'adb_command') as adb:
                    with self.assertRaises(ValueError):M.proof(run,probe,host,M.SESSION.digest(host))
                    adb.assert_not_called()


if __name__=='__main__':unittest.main()
