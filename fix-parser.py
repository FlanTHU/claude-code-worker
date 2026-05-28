#!/usr/bin/env python3
"""Fix hook-handler.js JSON parsing to extract result.result.payloads[0].text"""
import pathlib
import re

target = pathlib.Path('/app/dist/extensions/topic-router/src/hook-handler.js')
t = target.read_text()

# Replace the JSON parse + catch block with correct extraction logic
old_parse = """            try {
                const result = JSON.parse(stdout);
                const text = result?.reply?.text ?? result?.text ?? result?.output ?? stdout;
                resolve(typeof text === 'string' ? text : JSON.stringify(text));
            }
            catch {
                // Not JSON — use raw stdout, strip debugger lines
                const cleaned = stdout
                    .split('\\n')
                    .filter(l => !l.startsWith('Debugger listening') && !l.startsWith('For help, see:'))
                    .join('\\n')
                    .trim();
                resolve(cleaned || '(无回复)');
            }"""

new_parse = """            // Strip debugger/Track SDK noise before parsing
            const cleanedStdout = stdout
                .split('\\n')
                .filter(l => !l.startsWith('Debugger listening') && !l.startsWith('For help, see:') && !l.startsWith('Track SDK:'))
                .join('\\n')
                .trim();
            try {
                const result = JSON.parse(cleanedStdout);
                const text = result?.result?.payloads?.[0]?.text ?? result?.reply?.text ?? result?.text ?? result?.output ?? cleanedStdout;
                resolve(typeof text === 'string' ? text : JSON.stringify(text));
            }
            catch {
                resolve(cleanedStdout || '(无回复)');
            }"""

if old_parse in t:
    t = t.replace(old_parse, new_parse)
    target.write_text(t)
    print('✅ Fixed JSON parsing in deployed hook-handler.js')
else:
    print('❌ Pattern not found. Current parse block:')
    idx = t.find('JSON.parse')
    if idx >= 0:
        # Show surrounding context
        start = max(0, idx - 200)
        end = min(len(t), idx + 400)
        print(t[start:end])
    else:
        print('JSON.parse not found in file at all')
