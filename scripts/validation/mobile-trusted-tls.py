"""Explicit caller-supplied TLS files for the existing loopback TLS process.

No acquisition, host/device trust mutation, DNS edit, or key discovery.
"""
import hashlib
import os
from pathlib import Path
import re
import socket
import ssl
import stat


def leaf_der(body):
    text=body.decode('ascii') if isinstance(body,bytes) else body
    certificates=re.findall(r'-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----',text)
    remainder=text
    for certificate in certificates:remainder=remainder.replace(certificate,'',1)
    if not certificates or remainder.strip():raise ValueError('certificate chain PEM only required')
    return ssl.PEM_cert_to_DER_cert(certificates[0])


def artifact(path,expected,private=False):
    path=Path(path).expanduser().absolute();info=path.lstat()
    if (path.resolve()!=path or not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or
        private and info.st_mode&0o077 or not 0<info.st_size<=131072 or not re.fullmatch('[a-f0-9]{64}',expected)):
        raise ValueError('explicit owned pinned TLS material required')
    body=path.read_bytes()
    if hashlib.sha256(body).hexdigest()!=expected:raise ValueError('caller TLS material pin mismatch')
    return path,body


def validate(value):
    if not isinstance(value,dict) or set(value)!={'hostname','certificate','certificateSha256','key','keySha256'}:
        raise ValueError('explicit trustedTls hostname/certificate/key and pins required')
    host=value['hostname']
    if not isinstance(host,str) or len(host)>253 or not re.fullmatch(r'(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{0,62}',host):
        raise ValueError('explicit caller-owned DNS hostname required')
    cert,cert_body=artifact(value['certificate'],value['certificateSha256']);leaf_der(cert_body)
    key,body=artifact(value['key'],value['keySha256'],True)
    if b'ENCRYPTED' in body[:100]:raise ValueError('noninteractive unencrypted private TLS key required')
    # An explicit callback prevents OpenSSL from ever prompting for a password.
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert),str(key),password=lambda:'')
    return dict(value,certificate=str(cert),key=str(key))


def stage(private,value):
    value=validate(value)
    for field,name,is_private in (('certificate','tls.crt',False),('key','tls.key',True)):
        _,body=artifact(value[field],value[field+'Sha256'],is_private)
        path=private/name
        with path.open('xb') as stream:stream.write(body)
        path.chmod(0o600)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(private/'tls.crt'),str(private/'tls.key'),password=lambda:'')
    # The existing TLS listener binds only loopback. A matching certificate alone
    # cannot establish a route; require the supplied name already routes here.
    addresses={entry[4][0] for entry in socket.getaddrinfo(value['hostname'],None,type=socket.SOCK_STREAM)}
    if not addresses or not addresses<= {'127.0.0.1','::1'}:
        raise ValueError('trusted hostname must already resolve to owned loopback; no DNS changes performed')
    return {'trustBasis':'SYSTEM_DEFAULT','hostname':value['hostname'],
        'leafDerSha256':hashlib.sha256(leaf_der((private/'tls.crt').read_bytes())).hexdigest(),
        'certificateSha256':value['certificateSha256'],'keyExported':False,'hostTrustChanged':False}


def client_context():
    context=ssl.create_default_context();context.verify_flags|=ssl.VERIFY_X509_STRICT
    return context
