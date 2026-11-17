"""Local CA and server TLS certificate generation and renewal."""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CA_VALIDITY_DAYS = 3650
SERVER_VALIDITY_DAYS = 397
RENEW_THRESHOLD_DAYS = 30


@dataclass(frozen=True)
class CertBundle:
    """Paths to generated CA and server certificates/keys."""

    ca_cert: Path
    ca_key: Path
    server_cert: Path
    server_key: Path
    fingerprint: str


def _generate_private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _write_key(path: Path, key: rsa.RSAPrivateKey) -> None:
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    path.write_bytes(pem)


def _write_cert(path: Path, cert: x509.Certificate) -> None:
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _load_key(path: Path) -> rsa.RSAPrivateKey:
    loaded = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(loaded, rsa.RSAPrivateKey):
        raise TypeError("Expected RSA private key")
    return loaded


def _load_cert(path: Path) -> x509.Certificate:
    return x509.load_pem_x509_certificate(path.read_bytes())


def _create_ca(ca_cert_path: Path, ca_key_path: Path) -> tuple[x509.Certificate, rsa.RSAPrivateKey]:
    key = _generate_private_key()
    now = datetime.now(UTC) - timedelta(minutes=5)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "Mouse Local CA"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Mouse"),
        ]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=CA_VALIDITY_DAYS))
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
    _write_cert(ca_cert_path, cert)
    return cert, key


def _desired_san_entries(ips: list[str], hostname: str) -> tuple[set[str], set[str]]:
    ip_set: set[str] = {"127.0.0.1"}
    for raw_ip in ips:
        stripped = raw_ip.strip()
        if not stripped:
            continue
        try:
            ipaddress.ip_address(stripped)
            ip_set.add(stripped)
        except ValueError:
            continue

    dns_set: set[str] = {"localhost"}
    clean_host = hostname.strip().rstrip(".")
    if clean_host:
        if not clean_host.endswith(".local"):
            dns_set.add(f"{clean_host}.local")
        else:
            dns_set.add(clean_host)
    return ip_set, dns_set


def _build_san_extension(ip_set: set[str], dns_set: set[str]) -> x509.SubjectAlternativeName:
    entries: list[x509.GeneralName] = [x509.DNSName(name) for name in sorted(dns_set)]
    entries.extend(x509.IPAddress(ipaddress.ip_address(ip)) for ip in sorted(ip_set))
    return x509.SubjectAlternativeName(entries)


def _server_cert_matches(
    cert: x509.Certificate,
    ca_cert: x509.Certificate,
    ip_set: set[str],
    dns_set: set[str],
) -> bool:
    now = datetime.now(UTC)
    if cert.not_valid_after_utc <= now + timedelta(days=RENEW_THRESHOLD_DAYS):
        return False
    if cert.issuer != ca_cert.subject:
        return False
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return False
    existing_ips = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
    existing_dns = set(san.get_values_for_type(x509.DNSName))
    return ip_set.issubset(existing_ips) and dns_set.issubset(existing_dns)


def _create_server_cert(
    server_cert_path: Path,
    server_key_path: Path,
    ca_cert: x509.Certificate,
    ca_key: rsa.RSAPrivateKey,
    ip_set: set[str],
    dns_set: set[str],
) -> x509.Certificate:
    key = _generate_private_key()
    now = datetime.now(UTC) - timedelta(minutes=5)
    common_name = sorted(ip_set - {"127.0.0.1"})[0] if (ip_set - {"127.0.0.1"}) else "localhost"
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Mouse"),
        ]
    )
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=SERVER_VALIDITY_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(_build_san_extension(ip_set, dns_set), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
    )
    cert = builder.sign(ca_key, hashes.SHA256())
    _write_key(server_key_path, key)
    _write_cert(server_cert_path, cert)
    return cert


def get_ca_fingerprint(ca_cert_path: Path) -> str:
    """Return colon-separated SHA-256 fingerprint of the CA certificate."""
    cert = _load_cert(ca_cert_path)
    digest = cert.fingerprint(hashes.SHA256()).hex().upper()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def ensure_certs(data_dir: Path, ips: list[str], hostname: str) -> CertBundle:
    """Ensure local CA exists and server certificate matches current SANs."""
    certs_dir = Path(data_dir) / "certs"
    certs_dir.mkdir(parents=True, exist_ok=True)
    ca_cert_path = certs_dir / "ca.crt"
    ca_key_path = certs_dir / "ca.key"
    server_cert_path = certs_dir / "server.crt"
    server_key_path = certs_dir / "server.key"

    if ca_cert_path.exists() and ca_key_path.exists():
        ca_cert = _load_cert(ca_cert_path)
        ca_key = _load_key(ca_key_path)
        if ca_cert.not_valid_after_utc <= datetime.now(UTC) + timedelta(days=RENEW_THRESHOLD_DAYS):
            ca_cert, ca_key = _create_ca(ca_cert_path, ca_key_path)
    else:
        ca_cert, ca_key = _create_ca(ca_cert_path, ca_key_path)

    ip_set, dns_set = _desired_san_entries(ips, hostname)
    need_new_server = True
    if server_cert_path.exists() and server_key_path.exists():
        existing = _load_cert(server_cert_path)
        if _server_cert_matches(existing, ca_cert, ip_set, dns_set):
            need_new_server = False

    if need_new_server:
        _create_server_cert(server_cert_path, server_key_path, ca_cert, ca_key, ip_set, dns_set)

    return CertBundle(
        ca_cert=ca_cert_path,
        ca_key=ca_key_path,
        server_cert=server_cert_path,
        server_key=server_key_path,
        fingerprint=get_ca_fingerprint(ca_cert_path),
    )
