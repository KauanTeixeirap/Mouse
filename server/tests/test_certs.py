"""Tests for local CA and server TLS certificate generation."""

from __future__ import annotations

import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

from mouse_server import network
from mouse_server.certs import (
    _generate_private_key,
    _write_cert,
    _write_key,
    ensure_certs,
    export_ca_der,
)


def test_ca_and_server_cert_properties(tmp_path: Path) -> None:
    bundle = ensure_certs(tmp_path, ips=["192.168.1.10"], hostname="MEUPC")

    ca_cert = x509.load_pem_x509_certificate(bundle.ca_cert.read_bytes())
    srv_pem_bytes = bundle.server_cert.read_bytes()
    srv_cert = x509.load_pem_x509_certificate(srv_pem_bytes)
    chain = x509.load_pem_x509_certificates(srv_pem_bytes)

    # Fullchain server.crt contains leaf + CA (2 PEM blocks)
    assert len(chain) == 2
    assert chain[0] == srv_cert
    assert chain[1] == ca_cert

    # CA extensions: digital_signature=True and AuthorityKeyIdentifier
    ca_ku = ca_cert.extensions.get_extension_for_class(x509.KeyUsage).value
    assert ca_ku.digital_signature is True
    assert ca_ku.key_cert_sign is True
    assert ca_ku.crl_sign is True
    ca_aki = ca_cert.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier).value
    ca_ski = ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
    assert ca_aki.key_identifier == ca_ski.digest

    # Leaf SubjectKeyIdentifier & AuthorityKeyIdentifier
    srv_ski = srv_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
    srv_aki = srv_cert.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier).value
    assert srv_ski.digest is not None
    assert srv_aki.key_identifier == ca_ski.digest

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

    # SAN entries (original + lowercase + .local)
    san = srv_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    san_ips = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
    san_dns = set(san.get_values_for_type(x509.DNSName))
    assert "192.168.1.10" in san_ips
    assert "127.0.0.1" in san_ips
    assert "localhost" in san_dns
    assert "MEUPC" in san_dns
    assert "meupc" in san_dns
    assert "MEUPC.local" in san_dns
    assert "meupc.local" in san_dns

    # DER export matches CA cert
    der_bytes = export_ca_der(bundle.ca_cert)
    der_cert = x509.load_der_x509_certificate(der_bytes)
    assert der_cert == ca_cert
    assert der_bytes == ca_cert.public_bytes(serialization.Encoding.DER)


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


def test_server_cert_regenerates_when_ca_key_changes(tmp_path: Path) -> None:
    bundle1 = ensure_certs(tmp_path, ips=["192.168.1.10"], hostname="MEUPC")
    srv_before = x509.load_pem_x509_certificate(bundle1.server_cert.read_bytes())

    # Replace CA with a newly generated CA keypair having the same Subject DN
    bundle1.ca_cert.unlink()
    bundle1.ca_key.unlink()
    from mouse_server.certs import _create_ca

    _create_ca(bundle1.ca_cert, bundle1.ca_key)

    # Even with identical IPs and hostname, ensure_certs must detect signature mismatch
    bundle2 = ensure_certs(tmp_path, ips=["192.168.1.10"], hostname="MEUPC")
    ca_after = x509.load_pem_x509_certificate(bundle2.ca_cert.read_bytes())
    srv_after = x509.load_pem_x509_certificate(bundle2.server_cert.read_bytes())
    assert srv_after.serial_number != srv_before.serial_number

    ca_pub = ca_after.public_key()
    assert isinstance(ca_pub, RSAPublicKey)
    assert srv_after.signature_hash_algorithm is not None
    ca_pub.verify(
        srv_after.signature,
        srv_after.tbs_certificate_bytes,
        PKCS1v15(),
        srv_after.signature_hash_algorithm,
    )


def test_legacy_ca_without_digital_signature_is_regenerated(tmp_path: Path) -> None:
    from datetime import UTC, datetime, timedelta

    from cryptography.x509.oid import NameOID

    certs_dir = tmp_path / "certs"
    certs_dir.mkdir(parents=True, exist_ok=True)
    ca_cert_path = certs_dir / "ca.crt"
    ca_key_path = certs_dir / "ca.key"

    key = _generate_private_key()
    now = datetime.now(UTC) - timedelta(minutes=5)
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "Mouse Local CA"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Mouse"),
        ]
    )
    legacy_ca = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    _write_key(ca_key_path, key)
    _write_cert(ca_cert_path, legacy_ca)

    bundle = ensure_certs(tmp_path, ips=["192.168.1.10"], hostname="MEUPC")
    new_ca = x509.load_pem_x509_certificate(bundle.ca_cert.read_bytes())
    assert new_ca.serial_number != legacy_ca.serial_number
    ku = new_ca.extensions.get_extension_for_class(x509.KeyUsage).value
    assert ku.digital_signature is True


def test_network_lan_ip_prioritization(monkeypatch) -> None:
    # VirtualBox (192.168.56.1) and WSL (172.24.0.1) should sort after physical LAN (192.168.1.42)
    monkeypatch.setattr(network, "get_primary_ip", lambda: "172.24.0.1")
    monkeypatch.setattr(
        network.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (network.socket.AF_INET, 0, 0, "", ("192.168.56.1", 0)),
            (network.socket.AF_INET, 0, 0, "", ("172.24.0.1", 0)),
            (network.socket.AF_INET, 0, 0, "", ("192.168.1.42", 0)),
        ],
    )

    class DummySock:
        def connect(self, target) -> None:
            raise OSError("offline")

        def close(self) -> None:
            pass

    monkeypatch.setattr(network.socket, "socket", lambda *a, **kw: DummySock())
    ips = network.get_lan_ips()
    assert ips[0] == "192.168.1.42"
    assert set(ips) == {"192.168.1.42", "172.24.0.1", "192.168.56.1"}


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

