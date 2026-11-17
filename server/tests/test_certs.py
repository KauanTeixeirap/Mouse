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
