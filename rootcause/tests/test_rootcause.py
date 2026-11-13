"""Tests of the rootcause command: the walk, the conclusion, the text input form, the store and the web UI."""
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock
import urllib.error
import urllib.request

sys.dont_write_bytecode = True

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / 'bin' / 'rootcause'

_loader = importlib.machinery.SourceFileLoader('rootcause', str(SCRIPT))
_spec = importlib.util.spec_from_loader('rootcause', _loader)
rc = importlib.util.module_from_spec(_spec)
_loader.exec_module(rc)

WHY = rc.WHY
AVOIDABLE = rc.AVOIDABLE
DECISION = "Could this decision be the mistake? If it may be, say so. If it is the user's, including something they asked for, ask them before you build around it."
ID = re.compile(r'^Started (rc-\d{8}-[0-9a-f]{6})\. ')


def entry(cause, reach='changeable', status='checked', **more):
    return {'cause': cause, 'evidence': f'Seen: {cause.lower()}', 'status': status, 'effects': [], 'reach': reach, **more}


def fix(cause, **more):
    return entry(cause, 'fix', fix='removes', change='Change one line', proportion='One line', **more)


LOOP = entry('The loop stops one short')
RANGE = fix('The range end is exclusive')
TRUNCATE = entry('The writer truncates on close', 'outside')
STOP = entry('Nothing deeper is worth naming', 'stop')
MORE = f"{rc.ASK_MORE['changeable']} {rc.HISTORY} {WHY}"
FIX_MORE = f"{rc.ASK_MORE['fix']} {rc.HISTORY} {WHY}"
LEFT_ALONE = rc.LEFT_ALONE


def left(*steps):
    return [{'step': step, 'reason': f'Left {step} alone'} for step in steps]


# Ends each named step's branch with a stop.
def settle(a, *steps):
    for step in steps:
        a, _ = rc.answer(a, {'step': step, 'causes': [STOP]})
    return a


# The times each cause was added and revised, left out where a test compares
# what was recorded.
def unstamped(value):
    if isinstance(value, dict):
        return {k: unstamped(v) for k, v in value.items() if k not in ('added', 'revised')}
    if isinstance(value, list):
        return [unstamped(v) for v in value]
    return value


def reply_of(step, a, input):
    try:
        return step(a, input)[1]
    except rc.Refusal as e:
        return f'refused: {e}'


def walk(*inputs):
    a, _ = rc.new_analysis('rc1', {'symptom': 'The export drops the last row'})
    for input in inputs:
        a, _ = rc.answer(a, input)
    return a


def concluded(a, left_alone):
    try:
        return rc.conclude(a, {'leftAlone': left_alone, 'avoidable': []}, '/state/rc1.json')[1]
    except rc.Refusal as e:
        return f'refused: {e}'


class Walk(unittest.TestCase):
    def test_start_asks_why_and_needs_a_symptom(self):
        self.assertEqual(rc.new_analysis('rc1', {'symptom': 'a'})[1], f'Started rc1. {rc.ASK} {WHY}')
        self.assertEqual(rc.ASK, 'Why does this happen, or, for a fact about the project or its history, why is it like this?')
        self.assertIn('what else it affects (look at callers and other uses)', WHY)
        with self.assertRaisesRegex(rc.Refusal, r'^Give symptom: what behaves wrongly, as it was observed\.$'):
            rc.new_analysis('rc1', {})

    def test_one_call_records_a_level_and_echoes_it_then_walks_the_first_changeable_cause(self):
        a = walk()
        self.assertEqual(
            reply_of(rc.answer, a, {'causes': [LOOP, TRUNCATE], 'combine': 'all'}),
            f'Recorded for the symptom: all needed together; 1 changeable; 2 outside your reach. rc1 step 1: The loop stops one short. {MORE}',
        )

    def test_a_fix_is_asked_for_its_causes_and_a_stop_ends_its_branch(self):
        self.assertEqual(
            reply_of(rc.answer, walk({'causes': [LOOP]}), {'causes': [RANGE]}),
            f'Recorded for step 1: one cause; 1.1 fix (removes). rc1 step 1.1: The range end is exclusive. {FIX_MORE}',
        )
        self.assertIn('does not end the questions', FIX_MORE)
        self.assertEqual(
            reply_of(rc.answer, walk({'causes': [LOOP]}, {'causes': [RANGE]}), {'causes': [entry('A one-off slip in a hand-written range', 'stop')]}),
            f'Recorded for step 1.1: one cause; 1.1.1 stop. rc1: every branch has ended, and the fixes cover the symptom. Run rootcause conclude with leftAlone: the reason you leave each branch end alone: 1.1.1. {LEFT_ALONE} {AVOIDABLE}',
        )
        self.assertRegex(reply_of(rc.answer, settle(walk({'causes': [LOOP]}, {'causes': [RANGE]}), '1.1'), {'step': '1.1.1', 'causes': [STOP]}), r'^refused: Step 1\.1\.1 ends its branch, so it takes no causes of its own\.')

    def test_each_entry_must_be_complete(self):
        a = walk()
        self.assertRegex(reply_of(rc.answer, a, {'effects': []}), r'^refused: Give causes: the causes of the step the question asks about\. rc1\. Why does this happen, or')
        self.assertRegex(reply_of(rc.answer, a, {'causes': []}), r'^refused: Give causes: a cause line for each, followed by its evidence, status, effects and reach, or a same line\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [LOOP, LOOP], 'combine': 'all'}), r'^refused: Give each cause once\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [LOOP, TRUNCATE]}), r'^refused: Give combine: all if the causes are needed together, any if each is enough alone, parts if each makes part of it\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{**LOOP, 'status': 'sure'}]}), r'^refused: Step 1: give status: checked, supported, hypothesis or refuted\.')
        no_effects = {k: v for k, v in LOOP.items() if k != 'effects'}
        self.assertRegex(reply_of(rc.answer, a, {'causes': [no_effects]}), r'^refused: Step 1: give effects: what else this cause affects, one effects line each, or effects: none\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{**LOOP, 'reach': 'maybe'}]}), r'^refused: Step 1: give reach\. Reach: changeable .* decision \(a choice the user made or asked for; a design they did not ask for is design\), needed \(in combine: parts only, a part that is what its purpose needs\), or stop \(.*\)\. A branch ends only at outside, decision, needed, stop or a kept design, never at a fix; .* For design, ask why it works this way')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{**LOOP, 'weight': 3}]}), r'^refused: Step 1: give weight as text')

    def test_a_fix_entry_carries_its_fix_and_a_hiding_fix_needs_a_reason(self):
        a = walk()
        self.assertRegex(reply_of(rc.answer, a, {'causes': [entry('A', 'fix', proportion='x')]}), r'^refused: Step 1: with reach fix or verdict change, give fix: removes, removes-and-guards, or hides\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [entry('A', 'fix', fix='removes')]}), r'^refused: Step 1: with reach fix or verdict change, give change')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [entry('A', 'fix', fix='removes', change='x')]}), r'^refused: Step 1: with reach fix or verdict change, give proportion')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [entry('A', 'fix', fix='hides', change='x', proportion='x')]}), r'^refused: Step 1: A guard, retry, special case or longer timeout that hides a cause you could fix is not a fix\.')
        hidden = settle(walk({'causes': [entry('A', 'fix', fix='hides', hideReason='the user agreed', change='Retry the call', proportion='x')]}), '1')
        self.assertIn('Fixed here: Retry the call. The change only hides the cause. Why: the user agreed.', concluded(hidden, left('1.1')))

    def test_a_hypothesis_is_checked_before_the_walk_goes_below_it_and_what_was_walked_is_kept(self):
        a = walk({'causes': [entry('The writer truncates on close', status='hypothesis'), LOOP], 'combine': 'any'})
        self.assertRegex(reply_of(rc.answer, walk(), {'causes': [{'cause': 'Guess', 'evidence': 'Inferred', 'status': 'hypothesis'}]}), r'^Recorded for the symptom: one cause; 1 hypothesis\. rc1 step 1: Guess\. How would you check it\?')
        self.assertTrue(reply_of(rc.answer, walk(), {'causes': [entry('Guess', status='hypothesis')]}).startswith('Recorded for the symptom: one cause; 1 hypothesis, changeable. rc1 step 1: Guess. How would you check it? Check it, then give the causes of the symptom again with this one marked checked, or refuted,'))
        a, _ = rc.answer(a, {'step': '0', 'causes': [entry('The writer truncates on close', status='hypothesis'), LOOP], 'combine': 'any'})
        a, _ = rc.answer(a, {'step': '2', 'causes': [RANGE]})
        a = settle(a, '2.1')
        checked, reply = rc.answer(a, {'step': '0', 'causes': [TRUNCATE, LOOP], 'combine': 'any'})
        self.assertEqual(unstamped(checked['why']['causes'][1]['why']), {'combine': 'all', 'causes': [{**RANGE, 'why': {'combine': 'all', 'causes': [STOP]}}]})
        self.assertTrue(reply.startswith('Recorded for the symptom: any one is enough; 1 outside your reach; 2 changeable. rc1: every branch has ended, but the fixes do not settle the symptom. Step 1 is enough alone to cause the symptom'))

    def test_a_refuted_cause_is_kept_but_never_walked_and_a_level_with_only_refuted_causes_is_asked_again(self):
        refuted = {'cause': 'The disk is full', 'evidence': 'df shows 40% free', 'status': 'refuted'}
        a, reply = rc.answer(walk(), {'causes': [refuted, LOOP]})
        self.assertTrue(reply.startswith('Recorded for the symptom: one cause; 1 ruled out; 2 changeable. rc1 step 2: The loop stops one short. And why'))
        self.assertEqual(unstamped(a['why']['causes'][0]), refuted)
        self.assertRegex(reply_of(rc.answer, walk(), {'causes': [refuted]}), r'^Recorded for the symptom: one cause; 1 ruled out\. rc1\. Every cause given for the symptom was ruled out\. Why does this happen, or')
        done = settle(rc.answer(a, {'causes': [{**RANGE, 'weight': '5 of 7 passes'}]})[0], '2.1')
        self.assertIn('1 The disk is full. Ruled out.\n2 The loop stops one short.\n  2.1 The range end is exclusive. Weight: 5 of 7 passes. Fixed here', concluded(done, left('2.1.1')))

    def test_a_decision_ends_its_branch_and_asks_whether_it_is_the_mistake(self):
        self.assertEqual(
            reply_of(rc.answer, walk({'causes': [LOOP]}), {'causes': [entry('The format drops trailing rows by design', 'decision'), RANGE], 'combine': 'all'}),
            f'Recorded for step 1: all needed together; 1.1 decision; 1.2 fix (removes). Step 1.1 ends at a deliberate decision. {DECISION} rc1 step 1.2: The range end is exclusive. {FIX_MORE}',
        )

    def test_a_design_needs_its_purpose_and_a_verdict(self):
        a = walk({'causes': [LOOP]})
        self.assertRegex(reply_of(rc.answer, a, {'causes': [entry('Rows are written in pages by design', 'design')]}), r'^refused: Step 1\.1: with reach design, give purpose and verdict\. For design, ask why it works this way')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [entry('Rows are written in pages by design', 'design', purpose='Bounded memory', verdict='keep')]}), r'^refused: Step 1\.1: with verdict keep, give keepReason')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [entry('Rows are written in pages by design', 'design', purpose='Bounded memory', verdict='change')]}), r'^refused: Step 1\.1: with reach fix or verdict change, give fix')

    def test_a_design_to_change_is_a_fix_whose_decision_is_asked_about_and_a_kept_one_ends_its_branch(self):
        change = entry('Rows are written in pages by design', 'design', purpose='Bounded memory; a stream also bounds it', verdict='change', fix='removes', change='Stream the rows', proportion='Removes the whole class of page-edge drops')
        keep = entry('Rows are written in pages by design', 'design', purpose='Bounded memory, still needed', verdict='keep', keepReason='Memory matters more than this edge')
        changed = walk({'causes': [LOOP]}, {'causes': [change]})
        reply = reply_of(rc.answer, walk({'causes': [LOOP]}), {'causes': [change]})
        self.assertIn('1.1 design (change, removes)', reply)
        self.assertTrue(reply.endswith(f"rc1 step 1.1: Rows are written in pages by design. {rc.ASK_MORE['design']} {rc.HISTORY} {WHY}"), reply)
        self.assertIn('Why was it designed so in the first place?', rc.ASK_MORE['design'])
        self.assertFalse(rc.check(changed)[0])
        changed = settle(changed, '1.1')
        self.assertEqual(rc.check(changed), (True, 'rc1 is ready to conclude with leftAlone for 1.1.1, and avoidable.'))
        self.assertIn('  1.1 Rows are written in pages by design. Designed so. Purpose: Bounded memory; a stream also bounds it. Fixed here: Stream the rows. The change removes the cause.', concluded(changed, left('1.1.1')))
        kept = settle(walk({'causes': [LOOP]}, {'causes': [keep, RANGE], 'combine': 'all'}), '1.2')
        self.assertEqual(rc.check(kept), (True, 'rc1 is ready to conclude with leftAlone for 1.1, 1.2.1, and avoidable.'))
        self.assertIn('  1.1 Rows are written in pages by design. Designed so. Purpose: Bounded memory, still needed. Kept: Memory matters more than this edge. Left alone: Left 1.1 alone.', concluded(kept, left('1.1', '1.2.1')))
        self.assertFalse(rc.check(settle(walk({'causes': [LOOP]}, {'causes': [keep, RANGE], 'combine': 'any'}), '1.2'))[0])

    def test_a_cause_added_later_is_named_in_the_reply_and_walked_next(self):
        a = settle(walk({'causes': [LOOP]}, {'causes': [RANGE]}), '1.1')
        self.assertEqual(
            reply_of(rc.answer, a, {'step': '1', 'causes': [RANGE, entry('The writer buffers the last row')], 'combine': 'all'}),
            f'Recorded for step 1: all needed together; 1.1 fix (removes); 1.2 changeable. The causes of step 1 changed after their branches were walked: added 1.2. rc1 step 1.2: The writer buffers the last row. {MORE}',
        )
        self.assertRegex(reply_of(rc.answer, a, {'step': '1.1.1', 'causes': [TRUNCATE]}), r'^refused: Step 1\.1\.1 ends its branch')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [TRUNCATE]}), r'^refused: Every branch has ended\. To add a cause, give step')

    def test_a_refused_answer_leaves_the_analysis_unchanged(self):
        a = walk({'causes': [LOOP]})
        before = json.dumps(a)
        reply_of(rc.answer, a, {'causes': [{**RANGE, 'fix': 'none'}]})
        reply_of(rc.answer, a, {'step': '0', 'causes': [LOOP, RANGE]})
        self.assertEqual(json.dumps(a), before)


def supported(cause, reach='changeable', cites=('E1',), **more):
    return entry(cause, reach, status='supported', cites=list(cites), proof='Replay the request from the night of the outage', unprovable='The request logs of that night were rotated away', **more)


LAG = [{'id': 'E1', 'text': 'Lag peaks at 02:10'}]


class Supported(unittest.TestCase):
    def test_a_supported_cause_needs_proof_and_a_real_unprovable(self):
        a = walk()
        a, _ = rc.answer(a, {'evidenceItems': LAG, 'causes': [entry('The cache served a stale row', status='hypothesis')]})
        bare = entry('The cache served a stale row', status='supported', cites=['E1'])
        self.assertRegex(reply_of(rc.answer, a, {'causes': [bare]}), r'^refused: Step 1: with status supported, give proof: the check that would prove it\. A supported cause cites at least one evidence item, and gives proof')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{**bare, 'proof': 'Replay it'}]}), r'^refused: Step 1: give unprovable: why the check that would prove it cannot be run')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{**bare, 'proof': 'Replay it', 'unprovable': 'logs gone'}]}), r'^refused: Step 1: give unprovable:')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{**bare, 'proof': 'Replay it', 'unprovable': 'Replaying all of it would take too long'}]}), r'^refused: Step 1: unprovable names only the effort of the check\. .*That it would take long or is hard is not a reason')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{**LOOP, 'proof': 'Replay it'}]}), r'^refused: Step 1: proof and unprovable belong to a supported cause\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [supported('The cache served a stale row', cites=())]}), r'^refused: Step 1: with status supported, cite at least one evidence item with cites: E1\. Inline evidence alone does not make a cause supported\.')

    def test_a_supported_cause_never_ends_a_branch_and_is_never_fixed(self):
        a = walk({'evidenceItems': LAG, 'causes': [entry('The cache served a stale row', status='hypothesis')]})
        for reach, more in [('stop', {}), ('outside', {}), ('decision', {}), ('design', {'purpose': 'Speed', 'verdict': 'keep', 'keepReason': 'Speed matters more'})]:
            self.assertRegex(reply_of(rc.answer, a, {'causes': [supported('The cache served a stale row', reach, **more)]}), r'^refused: Step 1: A supported cause cannot end a branch: its support rests on evidence, so the walk goes on below it\. Give reach changeable')
        for reach, more in [('fix', {'fix': 'removes', 'change': 'Change one line', 'proportion': 'One line'}), ('design', {'purpose': 'Speed', 'verdict': 'change', 'fix': 'removes', 'change': 'Change one line', 'proportion': 'One line'})]:
            self.assertRegex(reply_of(rc.answer, a, {'causes': [supported('The cache served a stale row', reach, **more)]}), r'^refused: Step 1: A supported cause cannot be fixed: you cannot fix what you cannot measure\. Fix a checked cause below it\. If what keeps it from being checked is missing logging or instrumentation')
        self.assertIn('cannot be run', rc.WHY)

    def test_the_walk_goes_below_a_supported_cause_as_below_a_checked_one(self):
        a, reply = rc.answer(walk(), {'evidenceItems': LAG, 'causes': [supported('The cache served a stale row')]})
        self.assertEqual(reply, f'Recorded for the symptom: one cause; 1 supported, changeable. rc1 step 1: The cache served a stale row. {MORE}')
        self.assertEqual({k: a['why']['causes'][0][k] for k in ('status', 'proof', 'unprovable')}, {'status': 'supported', 'proof': 'Replay the request from the night of the outage', 'unprovable': 'The request logs of that night were rotated away'})
        a, reply = rc.answer(a, {'causes': [fix('The invalidation skips replicas')]})
        self.assertTrue(reply.endswith(f'rc1 step 1.1: The invalidation skips replicas. {FIX_MORE}'), reply)

    def test_a_hypothesis_check_may_resolve_to_supported(self):
        a, reply = rc.answer(walk(), {'evidenceItems': LAG, 'causes': [entry('The cache served a stale row', status='hypothesis')]})
        self.assertIn('How would you check it?', reply)
        self.assertIn('Only if no check that would prove it can be run, mark it supported', reply)
        self.assertIn('That it would take long or is hard is not a reason', reply)
        a, reply = rc.answer(a, {'step': '0', 'causes': [supported('The cache served a stale row')]})
        self.assertTrue(reply.endswith(f'rc1 step 1: The cache served a stale row. {MORE}'), reply)

    def test_evidence_items_are_defined_once_and_cited_by_several_causes(self):
        body = ('evidence E1: The replica lag graph peaks at 40 s at 02:10\n'
                '  on the night of the outage\n'
                'combine: all\n'
                'cause: The cache served a stale row\n'
                'cites: E1\n'
                'status: supported\n'
                'proof: Replay the request\n'
                'unprovable: The request logs of that night were rotated away\n'
                'effects: none\n'
                'reach: changeable\n'
                'evidence E2: The deploy log shows a schema change at 02:05\n'
                'cause: The replica applied the change late\n'
                'evidence: Read the replica config\n'
                'cites: E1, E2\n'
                'status: checked\n'
                'effects: none\n'
                'reach: outside\n')
        value = rc.input_of(body)
        self.assertEqual(value['evidenceItems'], [{'id': 'E1', 'text': 'The replica lag graph peaks at 40 s at 02:10\non the night of the outage'}, {'id': 'E2', 'text': 'The deploy log shows a schema change at 02:05'}])
        self.assertEqual([c['cites'] for c in value['causes']], ['E1', 'E1, E2'])
        a, _ = rc.answer(walk(), value, at='T1')
        self.assertEqual(a['evidenceItems'], [{'id': 'E1', 'text': 'The replica lag graph peaks at 40 s at 02:10\non the night of the outage', 'added': 'T1'}, {'id': 'E2', 'text': 'The deploy log shows a schema change at 02:05', 'added': 'T1'}])
        self.assertEqual([c['cites'] for c in a['why']['causes']], [['E1'], ['E1', 'E2']])
        self.assertNotIn('evidence', a['why']['causes'][0])
        self.assertRegex(reply_of(rc.answer, a, {'step': '1', 'causes': [{**STOP, 'cites': 'E3'}]}), r'^refused: Step 1\.1: cites E3, which is not defined\. Define it with an evidence E3: line\.')
        self.assertRegex(reply_of(rc.answer, a, {'step': '1', 'causes': [{**STOP, 'cites': 'nope'}]}), r'^refused: Step 1\.1: give cites as evidence ids')
        self.assertRegex(reply_of(rc.answer, a, {'step': '1', 'evidenceItems': [{'id': 'E1', 'text': 'Something else'}], 'causes': [STOP]}), r'^refused: Evidence E1 is already defined as: The replica lag graph')
        again, _ = rc.answer(a, {'step': '1', 'evidenceItems': [{'id': 'E1', 'text': 'The replica lag graph peaks at 40 s at 02:10\non the night of the outage'}], 'causes': [{**STOP, 'cites': ['E1']}]})
        self.assertEqual(len(again['evidenceItems']), 2)
        no_evidence = {k: v for k, v in STOP.items() if k != 'evidence'}
        self.assertRegex(reply_of(rc.answer, a, {'step': '1', 'causes': [no_evidence]}), r'^refused: Step 1\.1: give cause and evidence, or cites\.')

    def test_the_report_says_how_many_unproven_links_each_fix_rests_on(self):
        a = walk({'evidenceItems': [{'id': 'E1', 'text': 'Lag peaks at 02:10'}], 'causes': [supported('The cache served a stale row', cites=['E1']), fix('The page renders twice')], 'combine': 'any'})
        a, _ = rc.answer(a, {'causes': [supported('The replica applied the change late', cites=['E1'])]})
        a, _ = rc.answer(a, {'causes': [fix('Nothing waits for the replica')]})
        a = settle(a, '1.1.1', '2')
        ready, reply = rc.check(a)
        self.assertEqual(reply, 'rc1 is ready to conclude with leftAlone for 1.1.1.1, 2.1, and avoidable. The fix at 1.1.1 rests on 2 unproven links: 1, 1.1. Say so in your report.')
        self.assertIn('The fix at 1.1.1 rests on 2 unproven links: 1, 1.1. Say so in your report. Run rootcause conclude', rc.prompt(a))
        report = concluded(a, left('1.1.1.1', '2.1'))
        self.assertIn('\n1 The cache served a stale row. Supported, not proven by E1. Proof: Replay the request from the night of the outage. Cannot be run: The request logs of that night were rotated away.\n', report)
        self.assertIn('    1.1.1 Nothing waits for the replica. Fixed here: Change one line. The change removes the cause. Rests on 2 unproven links: 1, 1.1.\n', report)
        self.assertIn('\n2 The page renders twice. Fixed here: Change one line. The change removes the cause.\n', report)
        self.assertIn('\nEvidence:\n- E1: Lag peaks at 02:10. Cited by 1, 1.1.\n', report)

    def test_a_record_without_cites_or_evidence_items_loads_and_reports(self):
        record = settle(walk({'causes': [LOOP]}, {'causes': [RANGE]}), '1.1')
        for _, c in rc.nodes(record):
            self.assertNotIn('cites', c)
        self.assertNotIn('evidenceItems', record)
        report = concluded(record, left('1.1.1'))
        self.assertNotIn('Evidence:', report)
        self.assertNotIn('unproven', report)
        self.assertEqual(rc.check(record), (True, 'rc1 is ready to conclude with leftAlone for 1.1.1, and avoidable.'))


class Same(unittest.TestCase):
    def shared(self):
        flush = entry('The flush is asynchronous')
        a = walk({'causes': [entry('The test reads too early'), entry('The CLI shows stale data')], 'combine': 'any'})
        a, _ = rc.answer(a, {'causes': [flush]})
        return a, flush

    def test_same_points_at_a_step_that_is_not_walked_again_and_counts_as_that_step(self):
        a, flush = self.shared()
        a, reply = rc.answer(a, {'causes': [fix('Nothing waits for the flush')]})
        self.assertTrue(reply.endswith(f'rc1 step 1.1.1: Nothing waits for the flush. {FIX_MORE}'))
        a, reply = rc.answer(a, {'causes': [STOP]})
        self.assertTrue(reply.endswith(f'rc1 step 2: The CLI shows stale data. {MORE}'))
        a, reply = rc.answer(a, {'causes': [{'same': '1.1'}]})
        self.assertEqual(reply, f'Recorded for step 2: one cause; 2.1 same as 1.1. rc1: every branch has ended, and the fixes cover the symptom. Run rootcause conclude with leftAlone: the reason you leave each branch end alone: 1.1.1.1. {LEFT_ALONE} {AVOIDABLE}')
        self.assertIn('\n  2.1 Same as 1.1.\n', concluded(a, left('1.1.1.1')))

    def test_same_names_a_step_elsewhere_that_exists_and_stands(self):
        a, _ = self.shared()
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{'same': '1'}]}), r'^refused: Step 1\.1\.1: same must name a step outside step 1\.1, and not one of its ancestors\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{'same': '3'}]}), r'^refused: Step 1\.1\.1: step 3 is not in the analysis\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{'same': 'x'}]}), r'^refused: Step 1\.1\.1: give same as a step such as 1\.2\.')

    def test_revising_a_level_renumbers_the_sames_that_point_into_it_and_refuses_to_drop_their_step(self):
        a, flush = self.shared()
        a, _ = rc.answer(a, {'causes': [fix('Nothing waits for the flush')]})
        a, _ = rc.answer(a, {'causes': [STOP]})
        a, _ = rc.answer(a, {'causes': [{'same': '1.1'}]})
        other = fix('The cache has no version')
        moved, _ = rc.answer(a, {'step': '1', 'causes': [other, flush], 'combine': 'all'})
        self.assertEqual(unstamped(moved['why']['causes'][1]['why']['causes'][0]), {'same': '1.2'})
        self.assertRegex(reply_of(rc.answer, a, {'step': '1', 'causes': [other]}), r'^refused: Step 1\.1 is named by same at step 2\.1, and this answer drops it or rules it out\.')


IMPORT = 'The import skips the last row'


def multi(*inputs):
    a, _ = rc.new_analysis('rc1', {'symptom': ['The export drops the last row', IMPORT]}, at='T0')
    for input in inputs:
        a, _ = rc.answer(a, input)
    return a


class Symptoms(unittest.TestCase):
    def test_start_takes_several_symptoms_and_walks_each_in_turn(self):
        self.assertEqual(rc.input_of('symptom: A\nsymptom: B\n  and C\n'), {'symptom': ['A', 'B\nand C']})
        a, reply = rc.new_analysis('rc1', rc.input_of(f'symptom: The export drops the last row\nsymptom: {IMPORT}\n'), at='T0')
        self.assertEqual(a['moreSymptoms'], [{'symptom': IMPORT, 'added': 'T0'}])
        self.assertTrue(reply.startswith('Started rc1. Symptoms S1, S2: the steps of S1 are numbered 1, 1.2, and those of S2 S2.1, S2.1.2.'), reply)
        self.assertTrue(reply.endswith(f'rc1 symptom S1: The export drops the last row. {rc.ASK} {WHY}'))
        self.assertEqual(rc.new_analysis('rc1', {'symptoms': ['A', 'B']})[0]['moreSymptoms'][0]['symptom'], 'B')
        with self.assertRaisesRegex(rc.Refusal, r'^Give each symptom once\.$'):
            rc.new_analysis('rc1', {'symptom': ['A', 'A']})
        a, reply = rc.answer(a, {'causes': [RANGE]})
        self.assertTrue(reply.startswith('Recorded for symptom S1: one cause; 1 fix (removes). rc1 step 1:'), reply)
        a, reply = rc.answer(a, {'causes': [STOP]})
        self.assertTrue(reply.endswith(f'rc1 symptom S2: {IMPORT}. {rc.ASK} {WHY}'), reply)
        a, reply = rc.answer(a, {'causes': [LOOP]})
        self.assertTrue(reply.startswith(f'Recorded for symptom S2: one cause; S2.1 changeable. rc1 step S2.1: {LOOP["cause"]}.'), reply)
        self.assertEqual(unstamped(a['moreSymptoms'][0]['why']['causes']), [LOOP])
        self.assertRegex(reply_of(rc.answer, a, {'step': 'S3', 'causes': [STOP]}), r'^refused: Symptom S3 is not in the analysis\.')
        self.assertRegex(reply_of(rc.answer, a, {'step': 'S2.', 'causes': [STOP]}), r'^refused: Give step as a number such as 1\.2 or S2\.1, or 0 or S2 for a symptom\.')
        self.assertRegex(reply_of(rc.answer, a, {'step': 's1.1', 'causes': [STOP, TRUNCATE], 'combine': 'all'}), r'^Recorded for step 1: all needed together; 1\.1 stop; 1\.2 outside your reach\.')

    def test_a_symptom_added_later_keeps_every_step_number_and_is_walked_after_the_others(self):
        a = settle(walk({'causes': [RANGE]}), '1')
        before = json.dumps(a)
        added, reply = rc.add_symptom(a, {'symptom': IMPORT}, at='T5')
        self.assertEqual(json.dumps(a), before)
        self.assertEqual({k: v for k, v in added.items() if k != 'moreSymptoms'}, a)
        self.assertEqual(added['moreSymptoms'], [{'symptom': IMPORT, 'added': 'T5'}])
        self.assertEqual(reply, f'Added symptom S2 to rc1. Its steps are S2.1 and so on; the steps already given keep their numbers. The walk takes each symptom in turn, and a same line may name a step of another symptom. rc1 symptom S2: {IMPORT}. {rc.ASK} {WHY}')
        self.assertRegex(reply_of(rc.add_symptom, added, {'symptom': IMPORT}), r'^refused: Give each symptom once\. Already in the analysis: S1 The export drops the last row\.; S2 The import')
        self.assertRegex(reply_of(rc.add_symptom, added, {}), r'^refused: Give symptom: the symptom to add')
        self.assertEqual(rc.check(added)[0], False)
        done, _ = rc.answer(added, {'causes': [{'same': '1'}]})
        self.assertEqual(rc.check(done), (True, 'rc1 is ready to conclude with leftAlone for 1.1, and avoidable.'))

    def test_same_links_across_symptoms_keeps_the_ancestor_rule_and_is_renumbered(self):
        flush = entry('The flush is asynchronous')
        a = multi({'causes': [entry('The test reads too early')]}, {'causes': [flush]}, {'causes': [fix('Nothing waits for the flush')]}, {'causes': [STOP]})
        self.assertRegex(reply_of(rc.answer, a, {'causes': [{'same': 'S2'}]}), r'^refused: Step S2\.1: give same as a step such as 1\.2\.')
        a, reply = rc.answer(a, {'causes': [{'same': '1.1'}]})
        self.assertTrue(reply.startswith('Recorded for symptom S2: one cause; S2.1 same as 1.1. rc1: every branch has ended, and the fixes cover every symptom.'), reply)
        self.assertRegex(reply_of(rc.answer, a, {'step': '1.1.1', 'causes': [{'same': 'S2.1'}]}), r'^refused: Step 1\.1\.1\.1: same must name a step outside step 1\.1\.1, and not one of its ancestors\.')
        moved, _ = rc.answer(a, {'step': '1', 'causes': [TRUNCATE, flush], 'combine': 'all'})
        self.assertEqual(unstamped(moved['moreSymptoms'][0]['why']['causes']), [{'same': '1.2'}])
        self.assertRegex(reply_of(rc.answer, a, {'step': '1', 'causes': [TRUNCATE]}), r'^refused: Step 1\.1 is named by same at step S2\.1')

    def test_conclude_needs_fixes_for_every_symptom_and_a_reason_for_every_branch_end(self):
        a = multi({'causes': [RANGE]}, {'causes': [STOP]}, {'causes': [entry('The importer is vendored', 'outside')]})
        self.assertEqual(rc.check(a), (False, 'rc1 is not ready to conclude. These fixes do not settle every symptom. No fix covers symptom S2: fix step S2.1, or a step below.'))
        self.assertRegex(concluded(a, left('1.1', 'S2.1')), r'^refused: rc1: every branch has ended, but the fixes do not settle every symptom\. No fix covers symptom S2')
        a, _ = rc.answer(a, {'step': 'S2', 'causes': [entry('The importer is vendored', 'outside'), {'same': '1'}], 'combine': 'all'})
        self.assertEqual(rc.check(a), (True, 'rc1 is ready to conclude with leftAlone for 1.1, S2.1, and avoidable.'))
        self.assertRegex(concluded(a, left('1.1')), r'^refused: Give leftAlone: each branch end, and why you leave it alone\. Missing: S2\.1\.')
        self.assertRegex(concluded(a, left('1.1', 'S3.1')), r'^refused: Step S3\.1 in leftAlone is not in the analysis\.')
        self.assertEqual(concluded(a, left('1.1', 'S2.1')), '\n'.join([
            'Put this report in your reply:',
            '',
            'Symptom S1: The export drops the last row.',
            'Why:',
            '1 The range end is exclusive. Fixed here: Change one line. The change removes the cause.',
            '  1.1 Nothing deeper is worth naming. Left alone: Left 1.1 alone.',
            f'Symptom S2: {IMPORT}.',
            'Why (all needed together):',
            'S2.1 The importer is vendored. Ends outside reach. Left alone: Left S2.1 alone.',
            'S2.2 Same as 1.',
            'Fixes by symptom:',
            '- S1: fixed at 1. Shares causes with S2.',
            '- S2: fixed at 1. Shares causes with S1.',
            'Shared causes: 1 (S1, S2).',
            'How it could have been avoided: nothing found.',
            'Evidence and reasons: /state/rc1.json',
        ]))

    def test_a_symptom_that_shares_no_cause_is_said_so(self):
        a = multi({'causes': [RANGE]}, {'causes': [STOP]}, {'causes': [fix('The importer skips a trailer')]}, {'causes': [STOP]})
        report = concluded(a, left('1.1', 'S2.1.1'))
        self.assertIn('- S2: fixed at S2.1. Shares no cause with the other symptoms.\nShared causes: none.', report)
        self.assertIn('S2.1 The importer skips a trailer. Fixed here: Change one line. The change removes the cause.\n  S2.1.1 Nothing deeper', report)
        self.assertEqual(rc.abandon(a, {'reason': 'Misread'})[1], f'Closed rc1 without a conclusion. Symptoms: S1 The export drops the last row. S2 {IMPORT}. Reason: Misread. Say in your reply that you dropped the analysis and why.')


class Conclusion(unittest.TestCase):
    def test_conclude_refuses_until_every_branch_ends(self):
        self.assertRegex(concluded(walk({'causes': [LOOP]}), []), r'^refused: Not every branch has ended yet\. rc1 step 1: The loop stops one short\. And why does that happen, or why is it like this\?')

    def test_under_any_each_cause_needs_a_fix_of_its_own_or_one_above_it_under_all_one_fix_is_enough(self):
        decided = entry('The range is set by the caller', 'decision')
        any_ = walk({'causes': [LOOP]}, {'causes': [decided, entry('The writer drops it', 'decision')], 'combine': 'any'})
        self.assertEqual(concluded(any_, []), 'refused: rc1: every branch has ended, but the fixes do not settle the symptom. No fix covers the symptom: fix step 1, or a step below. To add a fix, give the causes of a step again with step, and reach fix on the cause to fix.')
        one = settle(walk({'causes': [LOOP]}, {'causes': [RANGE, entry('The writer drops it', 'decision')], 'combine': 'any'}), '1.1')
        self.assertRegex(concluded(one, left('1.1.1', '1.2')), r'^refused: rc1: every branch has ended, but the fixes do not settle the symptom\. Step 1\.2 is enough alone to cause step 1, and no fix covers it: fix it, or a step below it, or step 1 itself\.')
        both = settle(walk({'causes': [LOOP]}, {'causes': [RANGE, fix('The writer drops it')], 'combine': 'any'}), '1.1', '1.2')
        self.assertRegex(concluded(both, left('1.1.1', '1.2.1')), r'^Put this report in your reply:')
        above = settle(walk({'causes': [fix('The loop stops one short')]}), '1')
        self.assertRegex(concluded(above, left('1.1')), r'^Put this report in your reply:')
        all_ = settle(walk({'causes': [LOOP]}, {'causes': [RANGE, TRUNCATE], 'combine': 'all'}), '1.1')
        self.assertRegex(concluded(all_, left('1.1.1', '1.2')), r'^Put this report in your reply:')

    def test_parts_need_coverage_and_each_part_its_share_and_need(self):
        cold = fix('Each chart is drawn from the raw rows', share='70 of 120 s', need='Drawn from daily totals, about 3 s')
        fit = entry('Writing the PDF', 'needed', share='10 of 120 s', need='About 10 s for 400 pages')
        a = walk({'causes': [LOOP]})
        self.assertRegex(reply_of(rc.answer, a, {'causes': [cold, fit], 'combine': 'parts'}), r'^refused: With combine: parts, give coverage: how the parts together make up all of step 1\.')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [cold, entry('Writing the PDF', 'needed')], 'combine': 'parts', 'coverage': '80 of 120 s'}), r'^refused: Part 2: give share: how much of the whole it makes, and need:')
        self.assertRegex(reply_of(rc.answer, a, {'causes': [RANGE, entry('Writing the PDF', 'needed')], 'combine': 'all'}), r'^refused: Cause 2: reach needed is for a part, under combine: parts\.')
        done = settle(rc.answer(a, {'causes': [cold, fit], 'combine': 'parts', 'coverage': '80 of 120 s; the rest is the totals query and startup'})[0], '1.1')
        report = concluded(done, left('1.1.1', '1.2'))
        self.assertIn('1 The loop stops one short. Its parts: 80 of 120 s; the rest is the totals query and startup.', report)
        self.assertIn('1.1 Each chart is drawn from the raw rows. Share: 70 of 120 s. Needs: Drawn from daily totals, about 3 s. Fixed here', report)
        self.assertIn('1.2 Writing the PDF. Share: 10 of 120 s. Needs: About 10 s for 400 pages. Its purpose needs it as it is.', report)

    def test_every_part_must_be_settled_on_its_own(self):
        cold = fix('Each chart is drawn from the raw rows', share='70 of 120 s', need='About 3 s')
        slow = entry('The totals query scans the whole table', 'decision', share='30 of 120 s', need='About 1 s')
        parts = settle(rc.answer(rc.new_analysis('rc1', {'symptom': 'The nightly report takes 120 s'})[0], {'causes': [cold, slow], 'combine': 'parts', 'coverage': '100 of 120 s'})[0], '1')
        self.assertRegex(concluded(parts, left('1.1', '2')), r'^refused: .*Step 2 makes part of the symptom, and nothing settles it: fix it or a step below it, show its purpose needs it \(reach needed\), or keep it as a design\.')
        kept = dict(slow, reach='design', purpose='No index to maintain on a table that takes many writes', verdict='keep', keepReason='30 s once a night is worth no index')
        done = settle(rc.answer(rc.new_analysis('rc1', {'symptom': 'The nightly report takes 120 s'})[0], {'causes': [cold, kept], 'combine': 'parts', 'coverage': '100 of 120 s'})[0], '1')
        self.assertTrue(concluded(done, left('1.1', '2')).startswith('Put this report in your reply:\n\nSymptom: The nightly report takes 120 s.\nWhy (each makes part of it; 100 of 120 s):'), concluded(done, left('1.1', '2')))

    def test_conclude_refuses_until_every_branch_end_has_a_left_alone_reason(self):
        ended = settle(walk({'causes': [LOOP]}, {'causes': [RANGE, TRUNCATE], 'combine': 'all'}), '1.1')
        self.assertRegex(concluded(ended, []), r'^refused: Give leftAlone: each branch end, and why you leave it alone\. Missing: 1\.1\.1, 1\.2\.')
        self.assertRegex(concluded(ended, left('1.2')), r'^refused: Give leftAlone: each branch end, and why you leave it alone\. Missing: 1\.1\.1\.')
        self.assertIn(LEFT_ALONE, concluded(ended, left('1.2')))
        self.assertIn('a cannot-tell with nothing tried, means you did not look', LEFT_ALONE)
        self.assertRegex(concluded(ended, left('1.1.1', '1.2')), r'^Put this report in your reply:')
        self.assertRegex(concluded(ended, [{'step': '4', 'reason': 'x'}]), r'^refused: Step 4 in leftAlone is not in the analysis\.')
        self.assertRegex(concluded(ended, [{'step': '1.2'}]), r'^refused: Give the reason you leave step 1\.2 alone\.')
        self.assertRegex(concluded(ended, None), r'^refused: Give leftAlone: a leftAlone line with the step and a reason line for each branch end\.')

    def test_check_reports_what_conclude_would_refuse_without_closing(self):
        self.assertEqual(rc.check(walk({'causes': [LOOP]}))[0], False)
        gap = walk({'causes': [LOOP]}, {'causes': [entry('A', 'decision'), TRUNCATE], 'combine': 'all'})
        self.assertEqual(rc.check(gap), (False, 'rc1 is not ready to conclude. These fixes do not settle the symptom. No fix covers the symptom: fix step 1, or a step below.'))
        ended = settle(walk({'causes': [LOOP]}, {'causes': [RANGE, TRUNCATE], 'combine': 'all'}), '1.1')
        self.assertEqual(rc.check(ended), (True, 'rc1 is ready to conclude with leftAlone for 1.1.1, 1.2, and avoidable.'))
        self.assertFalse(rc.check(walk({'causes': [RANGE]}))[0])
        self.assertEqual(rc.check(settle(walk({'causes': [RANGE]}), '1')), (True, 'rc1 is ready to conclude with leftAlone for 1.1, and avoidable.'))

    def test_the_report_is_one_line_per_step_and_names_the_state_file(self):
        a = walk(
            {'causes': [entry('The test reads the cache before the writer flushes'), entry('The test asserts on its first read with no wait')], 'combine': 'all'},
            {'causes': [entry('The writer flushes asynchronously by design', 'decision'), entry('The CI machines have slow disks', 'outside', weight='4 of 5 runners')], 'combine': 'any'},
            {'causes': [fix('The test does not wait for the flush')]},
            {'causes': [entry('The test was written before the writer went asynchronous', 'stop')]},
        )
        self.assertEqual(
            concluded(a, [{'step': '1.1', 'reason': 'The user chose fast writes'}, {'step': '1.2', 'reason': 'The CI hardware is not ours'}, {'step': '2.1.1', 'reason': 'A wait in the test removes it; no other test reads before the flush'}]),
            '\n'.join([
                'Put this report in your reply:',
                '',
                'Symptom: The export drops the last row.',
                'Why (all needed together):',
                '1 The test reads the cache before the writer flushes. Its causes: any one is enough.',
                '  1.1 The writer flushes asynchronously by design. Ends at a deliberate decision. Left alone: The user chose fast writes.',
                '  1.2 The CI machines have slow disks. Weight: 4 of 5 runners. Ends outside reach. Left alone: The CI hardware is not ours.',
                '2 The test asserts on its first read with no wait.',
                '  2.1 The test does not wait for the flush. Fixed here: Change one line. The change removes the cause.',
                '    2.1.1 The test was written before the writer went asynchronous. Left alone: A wait in the test removes it; no other test reads before the flush.',
                'How it could have been avoided: nothing found.',
                'Evidence and reasons: /state/rc1.json',
            ]),
        )

    def test_abandon_needs_a_reason(self):
        self.assertRegex(reply_of(rc.abandon, walk(), {}), r'^refused: Give reason: why you close the analysis without a conclusion\. rc1\. Why does this happen, or')


class Command(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.store = rc.Store(pathlib.Path(self.root.name))
        # The Claude Code session that runs the tests, and its transcripts, stay out of them.
        self.claude = pathlib.Path(self.root.name) / 'claude'
        self.enterContext(unittest.mock.patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(self.claude)}))
        os.environ.pop('CLAUDE_CODE_SESSION_ID', None)

    def run_command(self, *argv, input=None, body=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        text = body if body is not None else '' if input is None else json.dumps(input)
        code = rc.main(list(argv), io.StringIO(text), stdout, stderr, self.store)
        return stdout.getvalue().rstrip('\n') if code == 0 else f'refused: {stderr.getvalue().rstrip(chr(10))}'

    def start(self, symptom):
        return ID.match(self.run_command('start', input={'symptom': symptom})).group(1)

    def saved(self, id):
        return json.loads(self.store.path_of(id).read_text())

    def test_each_call_and_its_reply_append_to_the_log_refusals_too(self):
        id = self.start('The export drops the last row')
        self.run_command('answer', id, body='cause: The loop stops one short\nevidence: Read export.py\nstatus: hypothesis\n')
        self.run_command('answer', id, body='cause: half\n')
        log = self.store.log_of(id).read_text()
        self.assertEqual(log.count('=== '), 3)
        self.assertIn('start\n{"symptom": "The export drops the last row"}\n--- reply\nStarted ' + id, log)
        self.assertIn('cause: The loop stops one short\nevidence: Read export.py\nstatus: hypothesis\n--- reply\nRecorded', log)
        self.assertIn('--- reply\nRefused: ', log)

    def test_a_full_analysis_is_saved_after_each_call_and_kept_when_concluded(self):
        id = self.start('The nightly sync test fails about one run in five')
        self.assertEqual(self.saved(id)['status'], 'open')
        self.run_command('answer', id, input={'causes': [LOOP, TRUNCATE], 'combine': 'all'})
        self.assertEqual(unstamped(self.saved(id)['why']['causes'][1]), TRUNCATE)
        self.assertTrue(self.run_command('answer', id, input={'causes': [RANGE]}).endswith(FIX_MORE))
        self.assertTrue(self.run_command('answer', id, input={'causes': [STOP]}).endswith(f'Run rootcause conclude with leftAlone: the reason you leave each branch end alone: 1.1.1, 2. {LEFT_ALONE} {AVOIDABLE}'))
        self.assertEqual(self.run_command('check', id, body='never read'), f'{id} is ready to conclude with leftAlone for 1.1.1, 2, and avoidable.')
        self.assertTrue(self.run_command('conclude', id, input={'leftAlone': []}).startswith('refused: Give leftAlone: each branch end, and why you leave it alone. Missing: 1.1.1, 2.'))
        reasons = [{'step': '1.1.1', 'reason': 'A one-off slip; a shared range helper is in avoidable'}, {'step': '2', 'reason': 'The vendor library'}]
        self.assertRegex(self.run_command('conclude', id, input={'leftAlone': reasons, 'avoidable': [{'avoidable': 'A'}]}), r'^refused: Avoidable A: give avoid, worth: yes or no, and why\.')
        report = self.run_command('conclude', id, input={'leftAlone': reasons, 'avoidable': []})
        self.assertTrue(report.endswith(f'Evidence and reasons: {self.store.path_of(id)}'))
        saved = self.saved(id)
        self.assertEqual((saved['status'], saved['leftAlone']), ('concluded', reasons))
        self.assertIn('closed', saved)
        self.assertEqual(self.run_command('answer', id, input={'causes': [LOOP]}), f'refused: No open analysis has id {id}. None is open; run rootcause start.')

    def test_start_does_not_name_the_other_open_analyses_and_list_does(self):
        self.assertEqual(self.run_command('list'), 'None is open.')
        first = self.start('a')
        self.assertEqual(self.run_command('start', input={'symptom': 'b'}).split('. ', 1)[1], f'{rc.ASK} {WHY}')
        second = self.store.open()[1]['id']
        self.assertEqual(self.run_command('list'), f'{first} (a)\n{second} (b)')
        self.assertEqual(self.run_command('start', input={}), 'refused: Give symptom: what behaves wrongly, as it was observed.')

    def test_list_stale_names_this_projects_analyses_open_for_more_than_a_day(self):
        # An analysis left open is a finding nobody acts on.
        old = self.start('The export drops a row')
        today = self.start('Opened today')
        other = self.start('Another project')
        self.assertEqual(self.run_command('list', '--stale'), '')
        here = os.getcwd()
        for id, cwd in [(old, here), (other, '/elsewhere')]:
            a = self.saved(id)
            a.update(started='2026-10-20T19:25:11+00:00', cwd=cwd)
            self.store.path_of(id).write_text(json.dumps(a))
        self.assertEqual(self.saved(today)['cwd'], here)
        self.assertEqual(self.run_command('list', '--stale'), f'{old} (open since 2026-10-20: The export drops a row)')

    def test_list_stale_finds_the_project_from_the_sessions_transcript_and_compares_real_paths(self):
        base = pathlib.Path(self.root.name).resolve()
        checkout, worktree, sub, nested, dashed = base / 'repo' / 'checkout', base / 'repo' / 'worktree-a', base / 'repo' / 'checkout' / 'src', base / 'a' / 'b' / 'c', base / 'a' / 'b-c'
        for d in (worktree, sub, nested, dashed):
            d.mkdir(parents=True)
        (base / 'link').symlink_to(checkout)
        # Claude Code shortens a long project folder's name and adds a hash: only the transcript's cwd names the project.
        session = '3f2a9c1e-7b4d-4e8a-9c2f-1d5e6a7b8c90'
        folder = self.claude / 'projects' / '-repo-che-1a2b3c'
        folder.mkdir(parents=True)
        (folder / f'{session}.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in [{'type': 'summary'}, {'type': 'user', 'cwd': str(checkout)}, {'type': 'user', 'cwd': str(worktree)}]))
        found = {}
        for n, (name, cwd, more) in enumerate([
                ('in a worktree, from a session in the checkout', worktree, {'session': session}),
                ('in a subdirectory', sub, {}),
                ('in a worktree, with no transcript', worktree, {'session': '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'}),
                ('in a path with a dash', dashed, {})], 1):
            id = f'rc-20261020-00000{n}'
            self.store.save({'id': id, 'symptom': name, 'status': 'open', 'started': f'2026-10-20T1{n}:00:00+00:00', 'cwd': str(cwd), **more})
            found[name] = id
        ids = lambda cwd: [a['id'] for a in rc.stale(self.store, str(cwd))]
        self.assertEqual(ids(checkout), [found['in a worktree, from a session in the checkout'], found['in a subdirectory']])
        self.assertEqual(ids(base / 'link'), ids(checkout))
        self.assertEqual(ids(worktree), [found['in a worktree, with no transcript']])
        self.assertEqual(ids(nested), [])
        self.assertEqual(ids(dashed), [found['in a path with a dash']])

    def test_an_unknown_id_lists_the_open_analyses(self):
        self.assertEqual(self.run_command('conclude', 'rc1', input={}), 'refused: No open analysis has id rc1. None is open; run rootcause start.')
        id = self.start('The export drops the last row')
        self.assertEqual(self.run_command('answer', 'rc9', input={'causes': [LOOP]}), f'refused: No open analysis has id rc9. Open: {id} (The export drops the last row).')
        self.assertEqual(self.run_command('check'), f'refused: No open analysis has id (none given). Open: {id} (The export drops the last row).')

    def test_input_that_is_not_a_json_object_is_refused_with_the_open_question(self):
        id = self.start('A wrong total')
        self.assertRegex(self.run_command('answer', id, body='{"causes": none}'), rf'^refused: The input on stdin is not JSON \(.*\)\. Give one JSON object\. {id}\. Why does this happen, or')
        self.assertRegex(self.run_command('answer', id, input=[LOOP]), rf'^refused: Give the input on stdin as one JSON object\. {id}\. Why does this happen, or')

    def test_add_symptom_adds_to_an_open_analysis_and_list_names_the_first_and_how_many_more(self):
        id = self.start('The export drops the last row')
        self.run_command('answer', id, input={'causes': [RANGE]})
        reply = self.run_command('add-symptom', id, body=f'symptom: {IMPORT}\nsymptom: The report total is one short\n')
        self.assertTrue(reply.startswith(f'Added symptoms S2, S3 to {id}. Their steps are S2.1, S3.1 and so on;'), reply)
        self.assertTrue(reply.endswith(f'{id} step 1: The range end is exclusive. {FIX_MORE}'), reply)
        self.assertEqual([s['symptom'] for s in self.saved(id)['moreSymptoms']], [IMPORT, 'The report total is one short'])
        self.assertEqual(self.run_command('list'), f'{id} (The export drops the last row (and 2 more))')
        self.assertIn('add-symptom\nsymptom: ', self.store.log_of(id).read_text())
        self.assertRegex(self.run_command('add-symptom', 'rc9', body='symptom: x\n'), r'^refused: No open analysis has id rc9\.')

    def test_abandon_closes_an_open_analysis_and_keeps_it_with_its_reason(self):
        id = self.start('The total is wrong')
        self.assertEqual(
            self.run_command('abandon', id, input={'reason': 'I read the wrong column'}),
            f'Closed {id} without a conclusion. Symptom: The total is wrong. Reason: I read the wrong column. Say in your reply that you dropped the analysis and why.',
        )
        self.assertEqual((self.saved(id)['status'], self.saved(id)['reason']), ('abandoned', 'I read the wrong column'))
        self.assertEqual(self.run_command('list'), 'None is open.')


ANSWER_TEXT = '''step: 0
combine: any

cause: The loop stops one short
evidence: Seen: the loop stops one short
status: checked
effects: The import loop
effects: The report total
  on every page
reach: changeable

cause: The range end is exclusive
evidence: Read export.py: range(0, n - 1), "quoted" and 'quoted'
status: checked
effects: none
reach: fix
fix: removes
change: Change one line
proportion: One line
'''

# Claude Code 2.1.302 asks approval for any Bash command that matches this,
# even under an allow rule: "Contains brace with quote character".
BRACE_WITH_QUOTE = re.compile(r'\{[^}]*[\'"]')

AGENT = SCRIPT.parent.parent / 'agents' / 'rootcause.md'


class TextForm(unittest.TestCase):
    def test_key_value_lines_give_the_same_input_as_json(self):
        self.assertEqual(rc.input_of(ANSWER_TEXT), {
            'step': '0', 'combine': 'any', 'causes': [
                {'cause': 'The loop stops one short', 'evidence': 'Seen: the loop stops one short', 'status': 'checked', 'effects': ['The import loop', 'The report total\non every page'], 'reach': 'changeable'},
                {'cause': 'The range end is exclusive', 'evidence': 'Read export.py: range(0, n - 1), "quoted" and \'quoted\'', 'status': 'checked', 'effects': [], 'reach': 'fix', 'fix': 'removes', 'change': 'Change one line', 'proportion': 'One line'},
            ]})
        self.assertEqual(rc.input_of('same: 1.2\ncause: A\nevidence: B\n  and C\nstatus: hypothesis\n'), {'causes': [{'same': '1.2'}, {'cause': 'A', 'evidence': 'B\nand C', 'status': 'hypothesis'}]})
        self.assertEqual(rc.input_of('leftAlone: 2\nreason: The vendor library\nleftAlone: 3\nreason: A decision\n'), {'leftAlone': [{'step': '2', 'reason': 'The vendor library'}, {'step': '3', 'reason': 'A decision'}]})
        self.assertEqual(rc.input_of('leftAlone: none\n'), {'leftAlone': []})
        self.assertEqual(rc.input_of('symptom: The total is {wrong}\n'), {'symptom': 'The total is {wrong}'})
        self.assertEqual(rc.input_of('reason: I read the wrong column'), {'reason': 'I read the wrong column'})
        self.assertEqual(rc.input_of('{"reason": "JSON still works"}'), {'reason': 'JSON still works'})

    def test_malformed_lines_are_refused_with_the_line_number(self):
        for body, why in [
            ('', 'Give the input on stdin, as "key: value" lines.'),
            ('causes: none', 'Line 1: unknown key causes.'),
            ('evidence: Seen', 'Line 1: evidence belongs to a cause. Start the cause with a cause line.'),
            ('cause: A\ncombine: all\nstatus: checked', 'Line 3: status belongs to a cause. Start the cause with a cause line.'),
            ('leftAlone: 2\nstatus: checked', 'Line 2: status belongs to a cause. Start the cause with a cause line.'),
            ('cause: A\nstatus: checked\nstatus: refuted', 'Line 3: status is given twice.'),
            ('  indented', 'Line 1 is indented, but no value comes before it to continue.'),
            ('symptom: A\nno colon here', 'Line 2 is not "key: value": no colon here'),
        ]:
            with self.assertRaises(rc.Refusal) as e:
                rc.input_of(body)
            self.assertEqual(str(e.exception), why)

    def test_a_full_analysis_runs_in_the_text_form(self):
        store = rc.Store(pathlib.Path(self.enterContext(tempfile.TemporaryDirectory())))

        def run(*argv, body=''):
            stdout, stderr = io.StringIO(), io.StringIO()
            code = rc.main(list(argv), io.StringIO(body), stdout, stderr, store)
            return code, stdout.getvalue() + stderr.getvalue()

        code, out = run('start', body='symptom: The export drops the last row\n')
        id = ID.match(out).group(1)
        code, out = run('answer', id, body='cause: The range end is exclusive\nevidence: Read export.py\nstatus: checked\neffects: none\nreach: fix\nfix: removes\nchange: Make the range inclusive\nproportion: One line\n')
        self.assertEqual(code, 0)
        code, out = run('answer', id, body='cause: The range was copied from the import loop\nevidence: Read the commit log\nstatus: checked\neffects: none\nreach: stop\n')
        self.assertTrue(out.endswith(f'Run rootcause conclude with leftAlone: the reason you leave each branch end alone: 1.1. {LEFT_ALONE} {AVOIDABLE}\n'), out)
        code, out = run('conclude', id, body='leftAlone: none\n')
        self.assertIn('Missing: 1.1.', out)
        code, out = run('conclude', id, body='leftAlone: 1.1\nreason: The fix at 1 removes it; a shared range helper is in avoidable\n')
        self.assertIn('Give an avoidable line for each', out)
        code, out = run('conclude', id, body='leftAlone: 1.1\nreason: The fix at 1 removes it\navoidable: Two loops repeat the bounds\navoid: One helper owns the range\nworth: yes\nwhy: Three lines, and it ends the off-by-one class\n')
        self.assertIn('How it could have been avoided:\n- Two loops repeat the bounds. Change: One helper owns the range. Worth it: yes. Three lines, and it ends the off-by-one class.\n', out)
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith('Put this report in your reply:'), out)

    def test_the_text_form_takes_every_key_a_design_needs(self):
        value = rc.input_of('cause: The cache keeps every view on disk\nevidence: Read memo.py\nstatus: checked\neffects: none\nreach: design\npurpose: Share views across processes\nverdict: keep\nkeepReason: Most views are small\n')
        self.assertEqual({k: value['causes'][0][k] for k in ('purpose', 'verdict', 'keepReason')},
                         {'purpose': 'Share views across processes', 'verdict': 'keep', 'keepReason': 'Most views are small'})

    def test_the_agent_prompt_gives_its_input_in_the_text_form_with_no_brace_next_to_a_quote(self):
        prompt = AGENT.read_text(encoding='utf-8')
        commands = re.findall(r"^rootcause [a-z]+[^\n]*<<'EOF'\n.*?^EOF$", prompt, re.M | re.S)
        self.assertGreaterEqual(len(commands), 4)
        for command in commands:
            self.assertIsNone(BRACE_WITH_QUOTE.search(command), command)
            body = command.split('\n', 1)[1].rsplit('\n', 1)[0]
            rc.input_of(body)


class Times(unittest.TestCase):
    def test_each_cause_keeps_when_it_was_added_across_revisions_and_when_it_last_changed(self):
        a, _ = rc.answer(walk(), {'causes': [entry('Guess', status='hypothesis')]}, at='T1')
        self.assertEqual({k: a['why']['causes'][0][k] for k in ('added', 'revised')}, {'added': 'T1', 'revised': 'T1'})
        a, _ = rc.answer(a, {'causes': [entry('Guess'), TRUNCATE], 'combine': 'all'}, at='T2')
        a, _ = rc.answer(a, {'step': '0', 'causes': [entry('Guess'), TRUNCATE, entry('A cause found later', 'outside')], 'combine': 'all'}, at='T3')
        stamps = [(c.get('added'), c.get('revised')) for c in a['why']['causes']]
        self.assertEqual(stamps, [('T1', 'T2'), ('T2', 'T2'), ('T3', 'T3')])

    def test_a_record_without_times_gets_none_and_the_web_ui_estimates_them_from_the_log(self):
        root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        store = rc.Store(root)
        a = unstamped(walk({'causes': [entry('Guess', status='hypothesis')]}))
        a, _ = rc.answer(a, {'causes': [entry('Guess'), TRUNCATE], 'combine': 'all'}, at='T2')
        self.assertNotIn('added', a['why']['causes'][0])
        self.assertEqual(a['why']['causes'][0]['revised'], 'T2')
        a = {**unstamped(a), 'started': 'T0'}
        store.dir.mkdir(parents=True)
        store.log_of('rc1').write_text('=== T1 answer\ncause: Guess\nevidence: e\nstatus: hypothesis\n--- reply\nRecorded\n\n'
                                      '=== T1b answer\ncause: Other\n--- reply\nRefused: no\n\n'
                                      '=== T2 answer\n{"causes": [{"cause": "Guess"}, {"cause": "The writer truncates on close"}]}\n--- reply\nRecorded\n\n')
        shown = rc.with_stamps(a, store.log_of('rc1'))['why']['causes']
        self.assertEqual([(c['added'], c['revised'], c['estimated']) for c in shown], [('T1', 'T2', True), ('T2', 'T2', True)])
        self.assertEqual(rc.with_stamps(a, root / 'none.log')['why']['causes'][0]['added'], 'T0')


def process_now():
    return os.getpid(), rc.process_of(os.getpid())[2]


def process_gone():
    child = subprocess.Popen(['sleep', '30'])
    process = child.pid, rc.process_of(child.pid)[2]
    child.kill()
    child.wait()
    return process


class Web(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.claude = self.root / 'claude-sessions'
        self.claude.mkdir()
        self.store, self.sessions = rc.Store(self.root), rc.Sessions(self.root, self.claude)

    def serve(self):
        web = rc.Web(self.root, 0, self.claude)
        threading.Thread(target=web.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        self.addCleanup(web.server_close)
        self.addCleanup(web.shutdown)
        return web, f'http://127.0.0.1:{web.server_address[1]}'

    def get(self, url, host=None):
        request = urllib.request.Request(url, headers={'Host': host} if host else {})
        try:
            with urllib.request.urlopen(request, timeout=5) as r:
                body = r.read()
                return r.status, json.loads(body) if r.headers['Content-Type'] == 'application/json' else body.decode()
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, None

    def analysis(self, id, session=None, started='2026-10-20T10:00:00+00:00'):
        a, _ = rc.answer({**walk(), 'id': id, 'status': 'open', 'started': started, **({'session': session} if session else {})}, {'causes': [LOOP]}, at=started)
        self.store.save(a)
        return a

    def test_the_server_lists_sessions_and_their_analyses_and_serves_each_analysis_and_the_page(self):
        self.analysis('rc-20261020-000001', 'session-a', '2026-10-20T10:00:00+00:00')
        self.analysis('rc-20261020-000002', None, '2026-10-20T11:00:00+00:00')
        self.analysis('rc-20261020-000003', 'session-b', '2026-10-20T12:00:00+00:00')
        self.sessions.register('session-a', claim='rc-20261020-000002')
        web, base = self.serve()
        status, rows = self.get(f'{base}/api/sessions')
        self.assertEqual([(r['session'], [a['id'] for a in r['analyses']]) for r in rows],
                         [('session-b', ['rc-20261020-000003']), ('session-a', ['rc-20261020-000002', 'rc-20261020-000001'])])
        status, listed = self.get(f'{base}/api/s/session-a')
        self.assertEqual([(a['id'], a['symptom'], a['status'], a['steps']) for a in listed['analyses']],
                         [('rc-20261020-000002', 'The export drops the last row', 'open', 1), ('rc-20261020-000001', 'The export drops the last row', 'open', 1)])
        status, a = self.get(f'{base}/api/a/rc-20261020-000001')
        self.assertEqual((status, a['why']['causes'][0]['cause'], a['why']['causes'][0]['added']), (200, LOOP['cause'], '2026-10-20T10:00:00+00:00'))
        self.assertEqual(self.get(f'{base}/api/a/rc-20261020-ffffff')[0], 404)
        self.assertEqual(self.get(f'{base}/api/a/..%2F..%2Fsecret')[0], 404)
        status, page = self.get(f'{base}/a/rc-20261020-000001')
        self.assertEqual(status, 200)
        self.assertIn('<title>rootcause</title>', page)
        self.assertEqual(self.get(f'{base}/api/sessions', host='evil.example')[0], 403)

    def test_a_record_whose_fix_has_no_causes_loads_and_an_open_one_is_asked_deeper(self):
        record = {**walk({'causes': [LOOP]}, {'causes': [RANGE]}), 'id': 'rc-20261001-000001', 'started': '2026-10-01T10:00:00+00:00'}
        self.store.save({**record, 'status': 'concluded', 'leftAlone': [], 'avoidable': [], 'report': 'Symptom: The export drops the last row.'})
        self.store.save({**record, 'id': 'rc-20261001-000002', 'status': 'open'})
        web, base = self.serve()
        status, a = self.get(f'{base}/api/a/rc-20261001-000001')
        self.assertEqual((status, a['status'], a['why']['causes'][0]['why']['causes'][0]['reach']), (200, 'concluded', 'fix'))
        self.assertEqual([a['id'] for a in self.store.open()], ['rc-20261001-000002'])
        self.assertTrue(rc.prompt(self.store.open()[0]).endswith(f'rc-20261001-000002 step 1.1: The range end is exclusive. {FIX_MORE}'))

    def test_a_record_with_one_symptom_is_served_as_saved_and_one_with_more_says_how_many(self):
        record = {**walk({'causes': [LOOP]}, {'causes': [RANGE]}), 'id': 'rc-20261001-000003', 'status': 'open', 'started': '2026-10-01T10:00:00+00:00', 'session': 'session-a'}
        self.store.save(record)
        several = {**multi({'causes': [RANGE]}, {'causes': [STOP]}, {'causes': [{'same': '1'}]}), 'id': 'rc-20261001-000004', 'status': 'open', 'started': '2026-10-01T11:00:00+00:00', 'session': 'session-a'}
        self.store.save(several)
        web, base = self.serve()
        status, a = self.get(f'{base}/api/a/rc-20261001-000003')
        self.assertEqual({k: v for k, v in a.items() if k != 'sessionInfo'}, record)
        self.assertEqual(self.get(f'{base}/api/a/rc-20261001-000004')[1]['moreSymptoms'][0]['why']['causes'][0]['same'], '1')
        listed = self.get(f'{base}/api/s/session-a')[1]['analyses']
        self.assertEqual([(s['id'], s['symptom'], s['more'], s['steps']) for s in listed], [('rc-20261001-000004', 'The export drops the last row', 1, 3), ('rc-20261001-000003', 'The export drops the last row', 0, 2)])

    def test_the_events_name_each_analysis_that_changes_and_count_as_a_client(self):
        a = self.analysis('rc-20261020-000001', 'session-a')
        web, base = self.serve()
        with urllib.request.urlopen(f'{base}/events', timeout=5) as r:
            self.assertEqual(r.readline(), b': hello\n')
            r.readline()
            self.assertEqual(web.clients, 1)
            self.assertTrue(web.is_wanted())
            self.store.save({**a, 'status': 'abandoned'})
            self.assertEqual(r.readline(), b'data: ["rc-20261020-000001.json"]\n')

    def test_the_server_stays_while_a_registered_process_runs_and_stops_after_the_grace_once_none_does(self):
        self.sessions.register('session-a', process_gone(), 'rc-20261020-000001')
        self.assertFalse(self.sessions.is_alive())
        self.assertEqual(self.sessions.load('session-a')['pids'], [])
        self.sessions.register('session-b', process_now())
        self.assertTrue(self.sessions.is_alive())
        web = rc.Web(self.root, 0, self.claude)
        web.check_seconds, web.grace_seconds = 0.05, 0.2
        stopped = threading.Thread(target=web.run, daemon=True)
        stopped.start()
        stopped.join(0.6)
        self.assertTrue(stopped.is_alive(), 'a live session keeps the server')
        self.sessions.save({**self.sessions.load('session-b'), 'pids': [{'pid': process_gone()[0], 'start': 'x'}]})
        stopped.join(3)
        self.assertFalse(stopped.is_alive(), 'with no live session and no page open, the server stops after the grace')

    def test_a_resumed_session_adds_its_new_process_and_a_dead_one_drops_only_its_own(self):
        gone, now = process_gone(), process_now()
        self.sessions.register('session-a', gone, 'rc-20261020-000001')
        self.sessions.register('session-a', now)
        self.sessions.register('session-a', now)
        self.assertEqual(self.sessions.load('session-a')['pids'], [{'pid': gone[0], 'start': gone[1]}, {'pid': now[0], 'start': now[1]}])
        self.assertTrue(self.sessions.is_alive())
        self.assertEqual(self.sessions.load('session-a')['pids'], [{'pid': now[0], 'start': now[1]}])
        self.assertEqual(self.sessions.load('session-a')['analyses'], ['rc-20261020-000001'])

    def test_a_backgrounded_session_is_followed_to_its_new_id_for_its_listing_and_its_liveness(self):
        gone, now = process_gone(), process_now()
        self.analysis('rc-20261020-000001', 'session-old', '2026-10-20T10:00:00+00:00')
        self.analysis('rc-20261020-000002', 'session-new', '2026-10-20T11:00:00+00:00')
        self.sessions.register('session-old', gone, 'rc-20261020-000001')
        (self.claude / f'{gone[0]}.json').write_text(json.dumps({'pid': gone[0], 'procStart': gone[1], 'sessionId': 'session-old', 'parkedJobId': 'job1'}))
        (self.claude / f'{now[0]}.json').write_text(json.dumps({'pid': now[0], 'procStart': now[1], 'sessionId': 'session-new', 'jobId': 'job1', 'kind': 'bg'}))
        self.sessions.follow()
        (self.claude / f'{gone[0]}.json').unlink()
        self.assertEqual(self.sessions.load('session-old')['continuedAs'], ['session-new'])
        self.assertTrue(self.sessions.is_alive(), 'the continuation runs')
        web, base = self.serve()
        for session in ('session-old', 'session-new'):
            listed = self.get(f'{base}/api/s/{session}')[1]
            self.assertEqual(([a['id'] for a in listed['analyses']], listed['sessions']), (['rc-20261020-000002', 'rc-20261020-000001'], ['session-new', 'session-old']))
        self.assertEqual([r['session'] for r in self.get(f'{base}/api/sessions')[1]], ['session-old'])
        (self.claude / f'{now[0]}.json').unlink()
        self.assertFalse(self.sessions.is_alive())

    def test_serve_registers_a_known_session_only_with_if_known_and_prints_its_page_when_the_server_runs(self):
        web, base = self.serve()
        port = str(web.server_address[1])
        self.enterContext(unittest.mock.patch.dict(os.environ, {'ROOTCAUSE_DIR': str(self.root), 'CLAUDE_CONFIG_DIR': str(self.root / 'none')}))

        def run(*argv):
            stdout = io.StringIO()
            return rc.main(['serve', '--port', port, *argv], io.StringIO(''), stdout, io.StringIO()), stdout.getvalue()

        self.assertEqual(run('--session', 'session-a', '--if-known'), (0, ''))
        self.assertIsNone(self.sessions.load('session-a'))
        self.assertEqual(run('--session', 'session-a', '--claim', 'rc-20261020-000001'), (0, f'{base}/s/session-a\n'))
        self.assertEqual(self.sessions.load('session-a')['analyses'], ['rc-20261020-000001'])
        self.assertEqual(run('--session', 'session-a', '--if-known'), (0, f'{base}/s/session-a\n'))
        self.assertEqual(run('--session', '../x')[0], 1)


class Program(unittest.TestCase):
    def test_the_script_replies_on_stdout_refuses_on_stderr_with_exit_1_and_runs_isolated(self):
        with tempfile.TemporaryDirectory() as root:
            env = {**os.environ, 'ROOTCAUSE_DIR': root}

            def run(*argv, input=''):
                return subprocess.run([sys.executable, '-I', str(SCRIPT), *argv], input=input, capture_output=True, text=True, env=env, cwd=root)

            started = run('start', input="symptom: The user's total is wrong\n")
            self.assertEqual((started.returncode, started.stderr), (0, ''))
            id = ID.match(started.stdout).group(1)
            self.assertTrue((pathlib.Path(root) / 'analyses' / f'{id}.json').is_file())
            refused = run('answer', id, input='{"reach": "changeable"}')
            self.assertEqual((refused.returncode, refused.stdout), (1, ''))
            self.assertTrue(refused.stderr.startswith('Give causes'))
            self.assertEqual(run('check', id).returncode, 1)
            with subprocess.Popen([sys.executable, '-I', str(SCRIPT), 'check', id], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env) as held:
                self.assertEqual(held.wait(timeout=10), 1, 'check must not wait for stdin, which a Bash call with a heredoc holds open')
                held.stdin.close()
            self.assertEqual(run('list').stdout, f"{id} (The user's total is wrong)\n")
            self.assertEqual((run('list', '--stale').returncode, run('list', '--stale').stdout), (0, ''))
            self.assertEqual(run('frobnicate').returncode, 2)


class SessionNames(unittest.TestCase):
    def test_a_session_is_named_by_its_given_name_then_its_title_and_placed_by_its_cwd(self):
        with tempfile.TemporaryDirectory() as d:
            claude = pathlib.Path(d)
            sid = '7c1e4b2a-9d3f-4a6e-b8c5-2f0d1e9a3b47'
            (claude / 'projects' / 'p').mkdir(parents=True)
            rows = [{'type': 'user', 'cwd': '/home/u/work'}, {'type': 'ai-title', 'aiTitle': 'A title'}]
            transcript = claude / 'projects' / 'p' / f'{sid}.jsonl'
            transcript.write_text(''.join(json.dumps(r) + '\n' for r in rows))
            names = rc.Names(claude)
            self.assertEqual(names.info(sid), {'name': 'A title', 'cwd': '/home/u/work'})
            transcript.write_text(transcript.read_text() + json.dumps({'type': 'agent-name', 'agentName': 'given'}) + '\n')
            os.utime(transcript, ns=(1, 1))
            self.assertEqual(names.info(sid)['name'], 'given')
            live = [{'sessionId': sid, 'pid': 1, 'name': 'renamed', 'nameSource': 'user', 'cwd': '/x'}]
            self.assertEqual(names.info(sid, live), {'name': 'renamed', 'cwd': '/home/u/work'})
            self.assertEqual(names.info('ffffffff-0000'), {'name': None, 'cwd': None})


if __name__ == '__main__':
    unittest.main()
