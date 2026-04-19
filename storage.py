from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import base64
import hashlib
import hmac
from pathlib import Path
from typing import Optional, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class BookStorage(Protocol):
    def ensure_ready(self) -> None: ...

    def save_book(self, storage_key: str, data: bytes) -> str: ...

    def read_book(self, storage_key: str) -> bytes: ...

    def delete_book(self, storage_key: str) -> None: ...


@dataclass
class LocalBookStorage:
    root_dir: Path

    def ensure_ready(self) -> None:
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def save_book(self, storage_key: str, data: bytes) -> str:
        path = self.root_dir / storage_key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return storage_key

    def read_book(self, storage_key: str) -> bytes:
        return (self.root_dir / storage_key).read_bytes()

    def delete_book(self, storage_key: str) -> None:
        (self.root_dir / storage_key).unlink(missing_ok=True)


@dataclass
class OssConfig:
    bucket: str
    endpoint: str
    access_key_id: str
    access_key_secret: str
    public_base_url: Optional[str] = None


@dataclass
class ObjectStorageBookStorage:
    config: OssConfig
    request_timeout_seconds: int = 15

    def ensure_ready(self) -> None:
        missing = [
            name
            for name, value in {
                "OSS_BUCKET": self.config.bucket,
                "OSS_ENDPOINT": self.config.endpoint,
                "OSS_ACCESS_KEY_ID": self.config.access_key_id,
                "OSS_ACCESS_KEY_SECRET": self.config.access_key_secret,
            }.items()
            if not value
        ]
        if missing:
            raise ValueError(f"Missing OSS configuration: {', '.join(missing)}")

    def save_book(self, storage_key: str, data: bytes) -> str:
        content_md5 = base64.b64encode(hashlib.md5(data).digest()).decode("ascii")
        content_type = "application/epub+zip"
        date_header = self._http_date()
        canonical_headers = ""
        canonical_resource = f"/{self.config.bucket}/{storage_key}"
        string_to_sign = "\n".join(["PUT", content_md5, content_type, date_header, canonical_headers + canonical_resource])
        signature = base64.b64encode(
            hmac.new(
                self.config.access_key_secret.encode("utf-8"),
                string_to_sign.encode("utf-8"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")
        request = Request(
            self._object_url(storage_key),
            data=data,
            method="PUT",
            headers={
                "Content-Type": content_type,
                "Content-MD5": content_md5,
                "Date": date_header,
                "Authorization": f"OSS {self.config.access_key_id}:{signature}",
            },
        )
        try:
            with urlopen(request, timeout=self.request_timeout_seconds) as response:
                if response.status not in (200, 201):
                    raise RuntimeError(f"OSS upload failed with status {response.status}")
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"OSS upload failed: HTTP {error.code}. {detail}".strip()) from error
        except URLError as error:
            raise RuntimeError(f"OSS upload failed: {error.reason}") from error
        return storage_key

    def read_book(self, storage_key: str) -> bytes:
        request = Request(self._object_url(storage_key), method="GET")
        self._sign_request(request, storage_key)
        with urlopen(request, timeout=self.request_timeout_seconds) as response:
            return response.read()

    def delete_book(self, storage_key: str) -> None:
        request = Request(self._object_url(storage_key), method="DELETE")
        self._sign_request(request, storage_key)
        try:
            with urlopen(request, timeout=self.request_timeout_seconds):
                return
        except Exception:
            # Keep delete best-effort so failed cleanup does not block user flows.
            return

    def _sign_request(self, request: Request, storage_key: str) -> None:
        date_header = self._http_date()
        canonical_headers = ""
        canonical_resource = f"/{self.config.bucket}/{storage_key}"
        string_to_sign = "\n".join(
            [request.get_method(), "", request.headers.get("Content-Type", ""), date_header, canonical_headers + canonical_resource]
        )
        signature = base64.b64encode(
            hmac.new(
                self.config.access_key_secret.encode("utf-8"),
                string_to_sign.encode("utf-8"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")
        request.add_header("Date", date_header)
        request.add_header("Authorization", f"OSS {self.config.access_key_id}:{signature}")

    def _object_url(self, storage_key: str) -> str:
        encoded_key = quote(storage_key.lstrip("/"), safe="/")
        if self.config.public_base_url:
            return f"{self.config.public_base_url.rstrip('/')}/{encoded_key}"
        return f"https://{self.config.bucket}.{self.config.endpoint}/{encoded_key}"

    def _http_date(self) -> str:
        return datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


def create_book_storage(
    mode: str,
    local_book_dir: Path,
    *,
    oss_bucket: str = "",
    oss_endpoint: str = "",
    oss_access_key_id: str = "",
    oss_access_key_secret: str = "",
    oss_public_base_url: str = "",
) -> BookStorage:
    if mode == "local":
        return LocalBookStorage(local_book_dir)
    if mode == "object-storage":
        return ObjectStorageBookStorage(
            OssConfig(
                bucket=oss_bucket,
                endpoint=oss_endpoint,
                access_key_id=oss_access_key_id,
                access_key_secret=oss_access_key_secret,
                public_base_url=oss_public_base_url or None,
            )
        )
    raise ValueError(f"Unsupported storage mode: {mode}")
