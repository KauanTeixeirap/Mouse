"""Tests for local CA and server TLS certificate generation."""

from __future__ import annotations

import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

from mouse_server.certs import ensure_certs


def test_ca_and_server_cert_properties(tmp_path: Path) -> None:
    bundle = ensure_certs(tmp_path, ips=["192.168.1.10"], hostname="MEUPC")

    ca_cert = x509.load_pem_x509_certificate(bundle.ca_cert.read_bytes())
    srv_cert = x509.load_pem_x509_certificate(bundle.server_cert.read_bytes())

    # Signed by CA
    assert srv_cert.issuer == ca_cert.subject
    ca_pub = ca_cert.public_key()
    assert isinstance(ca_pub, RSAPublicKey)
    assert srv_cert.signature_hash_algorithm is not None
    ca_pub.verify(
        srv_cert.signature,
        srv_cert.tbs_certificate_bytes,
        PKCS1v15(),
        srv_cert.signature_hash_algorithm,
    )

    # Validity <= 397 days
    validity_days = (srv_cert.not_valid_after_utc - srv_cert.not_valid_before_utc).days
    assert validity_days <= 397

    # SAN entries
    san = srv_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    san_ips = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
    san_dns = set(san.get_values_for_type(x509.DNSName))
    assert "192.168.1.10" in san_ips
    assert "127.0.0.1" in san_ips
    assert "localhost" in san_dns
    assert "MEUPC.local" in san_dns


def test_server_cert_regenerates_on_ip_change_keeping_ca(tmp_path: Path) -> None:
    bundle1 = ensure_certs(tmp_path, ips=["192.168.1.10"], hostname="MEUPC")
    ca_before = bundle1.ca_cert.read_bytes()
    srv_before = bundle1.server_cert.read_bytes()

    bundle2 = ensure_certs(tmp_path, ips=["192.168.1.25"], hostname="MEUPC")
    assert bundle2.ca_cert.read_bytes() == ca_before
    assert bundle2.server_cert.read_bytes() != srv_before

    srv_cert = x509.load_pem_x509_certificate(bundle2.server_cert.read_bytes())
    san = srv_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    san_ips = set(san.get_values_for_type(x509.IPAddress))
    assert ipaddress.ip_address("192.168.1.25") in san_ips


def test_live_ssl_context_reloads_new_ip_cert(tmp_path: Path) -> None:
    import socket
    import ssl
    import threading

    bundle1 = ensure_certs(tmp_path, ips=["192.168.1.10"], hostname="MEUPC")
    server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_ctx.load_cert_chain(str(bundle1.server_cert), str(bundle1.server_key))

    bundle2 = ensure_certs(tmp_path, ips=["192.168.1.99"], hostname="MEUPC")
    server_ctx.load_cert_chain(str(bundle2.server_cert), str(bundle2.server_key))

    client_ctx = ssl.create_default_context(cafile=str(bundle2.ca_cert))
    s_srv, s_cli = socket.socketpair()

    def _serve() -> None:
        with server_ctx.wrap_socket(s_srv, server_side=True) as tls_srv:
            tls_srv.recv(1)

    t = threading.Thread(target=_serve)
    t.start()
    try:
        with client_ctx.wrap_socket(s_cli, server_hostname="192.168.1.99") as tls_cli:
            tls_cli.send(b"1")
            der = tls_cli.getpeercert(binary_form=True)
            assert der is not None
            peer_cert = x509.load_der_x509_certificate(der)
            san = peer_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            san_ips = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
            assert "192.168.1.99" in san_ips
    finally:
        t.join(timeout=5)

