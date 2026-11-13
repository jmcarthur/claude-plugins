import pathlib
import re
import subprocess
import tempfile
import unittest

PLUGIN = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = re.search(r"APPEND_LOG =\s*'([^']*)'", (PLUGIN / 'hooks' / 'log.ts').read_text()).group(1)


def append(path, cap, text):
    subprocess.run(['sh', '-c', SCRIPT, 'sh', str(path), str(cap)], input=text, text=True, check=True)


class AppendLog(unittest.TestCase):
    def test_appends_and_rotates_past_the_cap(self):
        with tempfile.TemporaryDirectory() as d:
            log = pathlib.Path(d) / 'logs' / 's.jsonl'
            append(log, 8, 'one\n')
            append(log, 8, 'two\n')
            self.assertEqual(log.read_text(), 'one\ntwo\n')
            append(log, 8, 'three\n')
            self.assertEqual(log.read_text(), 'three\n')
            self.assertEqual(pathlib.Path(f'{log}.1').read_text(), 'one\ntwo\n')
            append(log, 5, 'four\n')
            self.assertEqual(log.read_text(), 'four\n')
            self.assertEqual(pathlib.Path(f'{log}.1').read_text(), 'three\n')


if __name__ == '__main__':
    unittest.main()
