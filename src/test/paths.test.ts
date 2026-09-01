import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDisplayPath, toNativePath } from '../server/paths.js';
import { encodePathParam } from '../shared/paths.js';

const WIN = 'win32';
const NIX = 'darwin';

test('windows paths are shown with forward slashes', () => {
    assert.equal(toDisplayPath('C:\\Users\\me\\Documents', WIN), 'C:/Users/me/Documents');
    assert.equal(toNativePath('C:/Users/me/Documents', WIN), 'C:\\Users\\me\\Documents');
});

test('the windows round trip is lossless', () => {
    for (const native of ['C:\\', 'C:\\Users\\me', 'D:\\a b\\c-d\\e.txt', '\\\\server\\share\\file']) {
        assert.equal(toNativePath(toDisplayPath(native, WIN), WIN), native, native);
    }
});

test('UNC paths survive both directions', () => {
    assert.equal(toDisplayPath('\\\\server\\share', WIN), '//server/share');
    assert.equal(toNativePath('//server/share', WIN), '\\\\server\\share');
});

test('posix paths are untouched on posix', () => {
    for (const path of ['/', '/Users/me', '/tmp/a b/c.txt']) {
        assert.equal(toDisplayPath(path, NIX), path);
        assert.equal(toNativePath(path, NIX), path);
    }
});

test('a posix path containing a backslash is not mangled on posix', () => {
    // A backslash is a legal filename character on POSIX, so it must survive.
    const odd = '/tmp/we\\ird/name';
    assert.equal(toDisplayPath(odd, NIX), odd);
    assert.equal(toNativePath(odd, NIX), odd);
});

test('query encoding keeps separators readable but escapes the rest', () => {
    assert.equal(encodePathParam('/Users/me/My Docs'), '/Users/me/My%20Docs');
    // A drive colon is legal in a query; escaping it to %3A is what made a
    // Windows path unreadable in the address bar.
    assert.equal(encodePathParam('C:/Users/me'), 'C:/Users/me');
    assert.equal(encodePathParam('C:/Program Files/App'), 'C:/Program%20Files/App');
    // The characters that would otherwise break out of the parameter.
    assert.equal(encodePathParam('/a?b&c#d'), '/a%3Fb%26c%23d');
});

test('an encoded path survives a real URL round trip', () => {
    for (const path of ['/Users/tbaskan/repos/MyDirStat', 'C:/Program Files/App', '/tmp/a&b?c#d/e f']) {
        const url = new URL(`http://127.0.0.1:1234/?path=${encodePathParam(path)}`);
        assert.equal(url.searchParams.get('path'), path, path);
    }
});
