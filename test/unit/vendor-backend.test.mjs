/**
 * The SHIPPED (vendored) ACL backend, exercised directly with crafted security-descriptor buffers.
 *
 * The upstream unit suite lives in the backend repository and is not part of this package. These
 * cases bind `vendor/dsh-sandbox-windows-acl/lib/acl.js` — the exact file a clean install runs — and
 * pin the two behaviours the delivery depends on:
 *
 * 1. a directory that already INHERITS the Low no-write-up label is authorized with a DACL-only
 *    SetNamedSecurityInfoW call (the reported Win32 5 fix), and
 * 2. the inherited-label walk is bounds-checked: a truncated ACE header, an ACE/SID length that
 *    overruns its ACE, an impossible subauthority count, or corruption AFTER a matching label all
 *    fall back to writing the label (fail-closed) instead of reading out of bounds or accepting a
 *    malformed descriptor early.
 *
 * Pure stubs: no real Win32 security calls happen here, so the file runs on every platform.
 */
import test from "node:test";
import assert from "node:assert/strict";
import koffi from "koffi";
import { grantWrite } from "../../vendor/dsh-sandbox-windows-acl/lib/acl.js";
import * as abi from "../../vendor/dsh-sandbox-windows-acl/lib/win32-abi.js";

const PVOID = koffi.pointer("void");
const INHERITED = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT | abi.INHERITED_ACE;

/** A binding table whose Win32 calls all succeed until a case overrides one. */
function stubApi(overrides = {}) {
	return {
		getTempPathW(_length, buffer) {
			const temp = process.env.TEMP ?? "C:\\Temp";
			buffer.write(temp, "utf16le");
			return temp.length;
		},
		createFileW: () => 7n,
		lockFileEx: () => 1,
		unlockFileEx: () => 1,
		closeHandle: () => 1,
		getNamedSecurityInfoW(_path, _type, _info, _owner, _group, dacl, sacl, descriptor) {
			koffi.encode(dacl, PVOID, 0n);
			koffi.encode(sacl, PVOID, 0n);
			koffi.encode(descriptor, PVOID, 0n);
			return 0;
		},
		setEntriesInAclW(_count, _entries, _old, newAcl) {
			koffi.encode(newAcl, PVOID, 9n);
			return 0;
		},
		setNamedSecurityInfoW: () => 0,
		localAlloc: () => 11n,
		getLengthSid: () => 12,
		initializeAcl: () => 1,
		addMandatoryAce: () => 1,
		localFree: () => 0n,
		getLastError: () => 5,
		formatMessageW: () => 0,
		...overrides,
	};
}

/** revision@0, subAuthorityCount@1, identifierAuthority@2..7, subauthorities@8. */
function craftSid(authority = [0, 0, 0, 0, 0, 16]) {
	const sid = koffi.alloc("uint8", 8);
	koffi.encode(sid, "uint8", 1);
	koffi.encode(sid, 1, "uint8", 0);
	authority.forEach((byte, index) => koffi.encode(sid, 2 + index, "uint8", byte));
	return sid;
}

const LOW_SID = craftSid();
const WORLD_SID = craftSid([0, 0, 0, 0, 0, 1]);

/** Write an ACE at `offset` with an inline 8-byte SID. */
function writeAce(acl, offset, aceType, mask, sid, flags) {
	koffi.encode(acl, offset, "uint8", aceType);
	koffi.encode(acl, offset + 1, "uint8", flags);
	koffi.encode(acl, offset + 2, "uint16", 16);
	koffi.encode(acl, offset + 4, "uint32", mask);
	for (let byte = 0; byte < 8; byte++) koffi.encode(acl, offset + 8 + byte, "uint8", koffi.decode(sid, byte, "uint8"));
}

/** A one-ACE ACL (header + 16-byte ACE). */
function craftAcl(aceType, mask, sid, flags = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT) {
	const acl = koffi.alloc("uint8", 32);
	koffi.encode(acl, "uint8", 2);
	koffi.encode(acl, 2, "uint16", 24);
	koffi.encode(acl, 4, "uint16", 1);
	writeAce(acl, 8, aceType, mask, sid, flags);
	return acl;
}

/** A DACL carrying the standing deny + the capability grant for `sid`. */
function grantedAcl(sid) {
	const acl = koffi.alloc("uint8", 64);
	koffi.encode(acl, "uint8", 2);
	koffi.encode(acl, 2, "uint16", 40);
	koffi.encode(acl, 4, "uint16", 2);
	writeAce(acl, 8, abi.ACCESS_DENIED_ACE_TYPE, abi.FILE_DELETE_CHILD, WORLD_SID, abi.CONTAINER_INHERIT_ACE);
	writeAce(acl, 24, abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
	return acl;
}

const capabilitySid = craftSid([0, 0, 0, 0, 4, 77]);

/** A security-info read stub returning the given DACL/label pointers. */
function readStub(dacl, label) {
	return (_path, _type, _info, _owner, _group, daclSlot, saclSlot, descriptorSlot) => {
		koffi.encode(daclSlot, PVOID, dacl === null ? 0n : koffi.address(dacl));
		koffi.encode(saclSlot, PVOID, label === null ? 0n : koffi.address(label));
		koffi.encode(descriptorSlot, PVOID, 6n);
		return 0;
	};
}

/** Wrap a function as a spy without a test framework. */
function spy(implementation) {
	const calls = [];
	const replacement = (...args) => {
		calls.push(args);
		return implementation(...args);
	};
	replacement.calls = calls;
	return replacement;
}

function applyOf(setNamed) {
	const call = setNamed.calls.at(-1);
	return { information: call[2], labelAcl: call[6] };
}

test("the shipped backend skips the apply when the ACE, deny, and inherited Low label all stand", () => {
	const setNamed = spy(() => 0);
	const api = stubApi({
		getNamedSecurityInfoW: readStub(grantedAcl(capabilitySid), craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_SID, INHERITED)),
		setNamedSecurityInfoW: setNamed,
	});
	grantWrite(api, "C:\\granted", capabilitySid, LOW_SID, WORLD_SID);
	assert.equal(setNamed.calls.length, 0);
});

test("the shipped backend authorizes an inherited-Low-label root with a DACL-only apply", () => {
	const setNamed = spy(() => 0);
	const api = stubApi({
		// No explicit DACL yet: a first grant on a child directory of a granted parent.
		getNamedSecurityInfoW: readStub(null, craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_SID, INHERITED)),
		setNamedSecurityInfoW: setNamed,
	});
	grantWrite(api, "C:\\granted", capabilitySid, LOW_SID, WORLD_SID);
	assert.equal(setNamed.calls.length, 1);
	const applied = applyOf(setNamed);
	assert.equal(applied.information & abi.LABEL_SECURITY_INFORMATION, 0, "the label must not be rewritten");
	assert.equal(applied.labelAcl, null);
});

test("the shipped backend writes the label when the inherited label lacks NO_WRITE_UP", () => {
	const setNamed = spy(() => 0);
	const api = stubApi({
		getNamedSecurityInfoW: readStub(null, craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, 0, LOW_SID, INHERITED)),
		setNamedSecurityInfoW: setNamed,
	});
	grantWrite(api, "C:\\granted", capabilitySid, LOW_SID, WORLD_SID);
	assert.equal(applyOf(setNamed).information & abi.LABEL_SECURITY_INFORMATION, abi.LABEL_SECURITY_INFORMATION);
});

test("the shipped backend does not accept an early label when a later ACE is malformed", () => {
	const label = koffi.alloc("uint8", 64);
	koffi.encode(label, "uint8", 2);
	koffi.encode(label, 2, "uint16", 40);
	koffi.encode(label, 4, "uint16", 2);
	writeAce(label, 8, abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_SID, INHERITED);
	koffi.encode(label, 24 + 2, "uint16", 100); // the second ACE claims to run past AclSize
	const setNamed = spy(() => 0);
	const api = stubApi({ getNamedSecurityInfoW: readStub(null, label), setNamedSecurityInfoW: setNamed });
	grantWrite(api, "C:\\granted", capabilitySid, LOW_SID, WORLD_SID);
	assert.equal(applyOf(setNamed).information & abi.LABEL_SECURITY_INFORMATION, abi.LABEL_SECURITY_INFORMATION);
});

test("the shipped backend does not read an ACE header outside AclSize", () => {
	const label = koffi.alloc("uint8", 32);
	koffi.encode(label, "uint8", 2);
	koffi.encode(label, 2, "uint16", 10); // only two bytes of the ACE header fit
	koffi.encode(label, 4, "uint16", 1);
	koffi.encode(label, 8, "uint8", abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE);
	koffi.encode(label, 9, "uint8", INHERITED);
	const setNamed = spy(() => 0);
	const api = stubApi({ getNamedSecurityInfoW: readStub(null, label), setNamedSecurityInfoW: setNamed });
	grantWrite(api, "C:\\granted", capabilitySid, LOW_SID, WORLD_SID);
	assert.equal(applyOf(setNamed).information & abi.LABEL_SECURITY_INFORMATION, abi.LABEL_SECURITY_INFORMATION);
});

test("the shipped backend rejects a label ACE whose declared SID overruns the ACE", () => {
	const label = craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_SID, INHERITED);
	koffi.encode(label, 8 + 9, "uint8", 5); // 8 + 5*4 = 28 SID bytes inside a 16-byte ACE
	const setNamed = spy(() => 0);
	const api = stubApi({ getNamedSecurityInfoW: readStub(null, label), setNamedSecurityInfoW: setNamed });
	grantWrite(api, "C:\\granted", capabilitySid, LOW_SID, WORLD_SID);
	assert.equal(applyOf(setNamed).information & abi.LABEL_SECURITY_INFORMATION, abi.LABEL_SECURITY_INFORMATION);
});

test("the shipped backend rejects an impossible subauthority count", () => {
	const label = craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, LOW_SID, INHERITED);
	koffi.encode(label, 8 + 9, "uint8", abi.SID_MAX_SUB_AUTHORITIES + 1);
	const setNamed = spy(() => 0);
	const api = stubApi({ getNamedSecurityInfoW: readStub(null, label), setNamedSecurityInfoW: setNamed });
	grantWrite(api, "C:\\granted", capabilitySid, LOW_SID, WORLD_SID);
	assert.equal(applyOf(setNamed).information & abi.LABEL_SECURITY_INFORMATION, abi.LABEL_SECURITY_INFORMATION);
});