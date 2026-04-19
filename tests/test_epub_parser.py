from pathlib import Path
import shutil
import unittest
import zipfile

from epub_parser import parse_epub


class ParseEpubTests(unittest.TestCase):
    def test_parse_minimal_epub(self) -> None:
        temp_dir = Path("tests/.tmp")
        temp_dir.mkdir(parents=True, exist_ok=True)
        path = temp_dir / "sample.epub"

        try:
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr(
                    "META-INF/container.xml",
                    """<?xml version="1.0"?>
                    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                      <rootfiles>
                        <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
                      </rootfiles>
                    </container>""",
                )
                archive.writestr(
                    "OPS/content.opf",
                    """<?xml version="1.0"?>
                    <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
                      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                        <dc:title>Sample Book</dc:title>
                        <dc:creator>Tester</dc:creator>
                      </metadata>
                      <manifest>
                        <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
                      </manifest>
                      <spine>
                        <itemref idref="c1"/>
                      </spine>
                    </package>""",
                )
                archive.writestr(
                    "OPS/chapter1.xhtml",
                    """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head>
                    <body><h1>Chapter One</h1><p>Hello world.</p></body></html>""",
                )

            parsed = parse_epub(path)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        self.assertEqual(parsed["title"], "Sample Book")
        self.assertEqual(parsed["author"], "Tester")
        self.assertEqual(parsed["chapters"][0]["title"], "Chapter One")
        self.assertIn("Hello world", parsed["chapters"][0]["plain_text"])


if __name__ == "__main__":
    unittest.main()
