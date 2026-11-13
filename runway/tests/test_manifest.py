import json
import pathlib
import re
import unittest

PLUGIN = pathlib.Path(__file__).resolve().parent.parent


class ManifestOptions(unittest.TestCase):
    def test_every_setting_is_read_and_every_read_setting_is_declared(self):
        manifest = json.loads((PLUGIN / '.claude-plugin' / 'plugin.json').read_text())
        declared = set(manifest['userConfig'])
        source = (PLUGIN / 'hooks' / 'options.ts').read_text()
        read = set(re.findall(r'options\.(\w+)', source)) | set(re.findall(r'^  (\w+): \{ (?:fallback|min)', source, re.M))
        self.assertEqual(declared, read)


if __name__ == '__main__':
    unittest.main()
