from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from io import BytesIO
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin


CONTAINER_NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
OPF_NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}
XHTML_NS = {"xhtml": "http://www.w3.org/1999/xhtml"}


class EpubParseError(ValueError):
    pass


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        normalized = re.sub(r"\s+", " ", data).strip()
        if normalized:
            self.parts.append(normalized)

    def text(self) -> str:
        return " ".join(self.parts)


def parse_epub(path: Path) -> dict[str, Any]:
    return _parse_epub_archive(zipfile.ZipFile(path), fallback_name=path.name)


def parse_epub_bytes(raw_bytes: bytes, fallback_name: str = "uploaded.epub") -> dict[str, Any]:
    try:
        archive = zipfile.ZipFile(BytesIO(raw_bytes))
    except zipfile.BadZipFile as error:
        raise EpubParseError("This file is not a valid EPUB.") from error
    return _parse_epub_archive(archive, fallback_name=fallback_name)


def _parse_epub_archive(archive: zipfile.ZipFile, fallback_name: str) -> dict[str, Any]:
    try:
        archive.namelist()
    except zipfile.BadZipFile as error:
        raise EpubParseError("This file is not a valid EPUB.") from error

    with archive:
        opf_path = locate_opf(archive)
        metadata, manifest, spine = parse_package(archive, opf_path)
        chapters = []
        opf_dir = opf_path.rsplit("/", 1)[0] if "/" in opf_path else ""
        for item_id in spine:
            href = manifest.get(item_id)
            if not href:
                continue
            chapter_path = resolve_relative(opf_dir, href)
            try:
                content = archive.read(chapter_path).decode("utf-8")
            except UnicodeDecodeError:
                content = archive.read(chapter_path).decode("utf-8", errors="ignore")
            title = extract_title(content) or Path(href).stem
            chapters.append(
                {
                    "href": chapter_path,
                    "title": title,
                    "content_html": sanitize_html(content),
                    "plain_text": extract_plain_text(content),
                }
            )
        if not chapters:
            raise EpubParseError("The EPUB does not contain readable chapters.")
        return {
            "title": metadata["title"] or Path(fallback_name).stem,
            "author": metadata["author"] or "Unknown author",
            "chapters": chapters,
        }


def locate_opf(archive: zipfile.ZipFile) -> str:
    try:
        container_xml = archive.read("META-INF/container.xml")
    except KeyError as error:
        raise EpubParseError("The EPUB is missing META-INF/container.xml.") from error
    root = ET.fromstring(container_xml)
    rootfile = root.find(".//c:rootfile", CONTAINER_NS)
    if rootfile is None:
        raise EpubParseError("Could not locate the OPF package document.")
    full_path = rootfile.attrib.get("full-path")
    if not full_path:
        raise EpubParseError("The OPF package path is empty.")
    return full_path


def parse_package(archive: zipfile.ZipFile, opf_path: str) -> tuple[dict[str, str], dict[str, str], list[str]]:
    package_xml = archive.read(opf_path)
    root = ET.fromstring(package_xml)
    title = root.findtext(".//dc:title", default="", namespaces=OPF_NS)
    author = root.findtext(".//dc:creator", default="", namespaces=OPF_NS)
    manifest = {
        item.attrib["id"]: item.attrib["href"]
        for item in root.findall(".//opf:manifest/opf:item", OPF_NS)
        if item.attrib.get("href")
    }
    spine = [
        item.attrib["idref"]
        for item in root.findall(".//opf:spine/opf:itemref", OPF_NS)
        if item.attrib.get("idref")
    ]
    return {"title": title.strip(), "author": author.strip()}, manifest, spine


def extract_title(html_text: str) -> str:
    try:
        root = ET.fromstring(html_text)
    except ET.ParseError:
        return ""
    title = root.findtext(".//xhtml:title", default="", namespaces=XHTML_NS)
    if title.strip():
        return title.strip()
    heading = root.find(".//xhtml:h1", XHTML_NS)
    if heading is not None and "".join(heading.itertext()).strip():
        return "".join(heading.itertext()).strip()
    return ""


def sanitize_html(content: str) -> str:
    body_match = re.search(r"<body[^>]*>(.*)</body>", content, flags=re.IGNORECASE | re.DOTALL)
    if body_match:
        return body_match.group(1)
    return content


def extract_plain_text(content: str) -> str:
    parser = TextExtractor()
    parser.feed(content)
    return parser.text()


def resolve_relative(base: str, href: str) -> str:
    joined = urljoin(f"{base}/", href)
    return joined.lstrip("/")
