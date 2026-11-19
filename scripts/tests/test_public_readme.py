from pathlib import Path
import importlib.util
import json
import tempfile
import unittest
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('public_readme', ROOT/'scripts/export_public_readme.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@contextmanager
def temporary_export():
    parent = ROOT/'codex-qq-plugin/test-output/public-readme-tests'
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temporary:
        path = Path(temporary).resolve()
        assert path.parent == parent.resolve()
        yield path


class PublicReadmeTests(unittest.TestCase):
    def test_current_export_contains_only_readme_and_reviewed_assets(self):
        files = module.build_files(ROOT)
        self.assertEqual(set(files), {'README.md', module.MANIFEST, *module.ASSETS})
        text = files['README.md'].decode()
        self.assertIn('动态气象', text)
        self.assertIn('docs/images/console.webp', text)
        for private in ['HANDOVER', 'npm ci', 'scripts/install-python', 'public-readme:private:']:
            self.assertNotIn(private, text)
        self.assertEqual(set(json.loads(files[module.MANIFEST])['files']), set(files)-{module.MANIFEST})

    def test_internal_section_is_rejected_in_the_published_readme(self):
        with self.assertRaises(ValueError):
            module.validate_text('<!-- public-readme:private:start -->', 'README.md', {'README.md'})

    def test_unexported_files_and_unsafe_links_fail(self):
        for href in ['HANDOVER.md', 'codex-qq-plugin/src/server.mjs', '../secrets.txt',
                     '%2e%2e/secrets.txt', 'file:///tmp/secret', '//example.com/x']:
            with self.subTest(href=href), self.assertRaises(ValueError):
                module.validate_text('[link]('+href+')', 'README.md', {'README.md'})

    def test_private_paths_and_credentials_fail(self):
        for text in ['C:\\Users\\Alex\\x', '/var/lib/alexbot', 'sk-'+'x'*32,
                     'https://github.com/Alexx-Powered/alex-bot/blob/main/README.md']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                module.validate_text(text, 'README.md', {'README.md'})

    def test_export_leaves_source_untouched_and_rejects_nonempty_destination(self):
        source = (ROOT/'README.md').read_bytes()
        with temporary_export() as temporary:
            destination = temporary/'export'
            files = module.export(ROOT, destination)
            self.assertEqual((destination/'README.md').read_bytes(), files['README.md'])
            with self.assertRaises(ValueError):
                module.export(ROOT, destination)
        self.assertEqual((ROOT/'README.md').read_bytes(), source)

    def test_missing_asset_prevents_partial_publication(self):
        with temporary_export() as root:
            (root/'README.md').write_bytes((ROOT/'README.md').read_bytes())
            with self.assertRaises(ValueError):
                module.export(root, root/'export')
            self.assertFalse((root/'export').exists())


if __name__ == '__main__':
    unittest.main()
