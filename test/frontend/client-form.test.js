import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientErrors, clientBody, validWebsite, CLIENT_LIMITS} from '../../public/assets/models/client-form.js';

const base = {type: 'company', name: 'Acme', email: '', phone: '', mobile: '', website: '', parentId: '', countryId: '', stateId: '', tagIds: []};

test('only the name is required, with a message for each type', () => {
  assert.deepEqual(clientErrors(base), {});
  assert.equal(clientErrors({...base, name: '  '}).name, 'Enter the company name.');
  assert.equal(clientErrors({...base, type: 'person', name: ''}).name, 'Enter the contact name.');
});

test('international names, phones and addresses are accepted', () => {
  const v = {...base, name: 'Ατλαντίς ΑΕ — 株式会社', phone: '+972 (0)50-123 4567', mobile: '+31 6 1234 5678', street: 'Rue de l’Église 12',
    city: 'München', zip: 'SW1A 1AA', vat: 'DE 123 456 789', website: 'example.co.il/shop', email: 'ana.ö@example.de'};
  assert.deepEqual(clientErrors(v), {});
});

test('bad email, phone without digits and bad web address are reported by field', () => {
  const e = clientErrors({...base, email: 'nope@', phone: 'call us', website: 'not a site'});
  assert.ok(e.email);
  assert.ok(e.phone);
  assert.ok(e.website);
});

test('a state needs a country, and only a person has a parent company', () => {
  assert.equal(clientErrors({...base, stateId: '20'}).stateId, 'Choose the country first.');
  assert.ok(clientErrors({...base, parentId: '2'}).parentId);
  assert.deepEqual(clientErrors({...base, type: 'person', parentId: '2'}), {});
});

test('length limits and control characters', () => {
  assert.ok(clientErrors({...base, name: 'x'.repeat(CLIENT_LIMITS.name + 1)}).name);
  assert.ok(clientErrors({...base, notes: 'x'.repeat(CLIENT_LIMITS.notes + 1)}).notes);
  assert.ok(clientErrors({...base, city: 'Tel\u0007Aviv'}).city);
  assert.deepEqual(clientErrors({...base, notes: 'line one\nline two'}), {});
});

test('validWebsite accepts a bare domain and rejects other schemes', () => {
  assert.equal(validWebsite('example.com'), true);
  assert.equal(validWebsite('https://example.com/a'), true);
  assert.equal(validWebsite('ftp://example.com'), false);
  assert.equal(validWebsite('no spaces.com here'), false);
});

test('blank optional values are left out of the body, values are trimmed', () => {
  const body = clientBody({...base, name: '  Acme  ', email: '  ', city: ' Haifa ', countryId: '10', stateId: '', parentId: ''});
  assert.deepEqual(body, {type: 'company', name: 'Acme', city: 'Haifa', countryId: 10});
});

test('a company never sends a parent company, and a person keeps it', () => {
  assert.equal(clientBody({...base, parentId: '2'}).parentId, undefined);
  assert.equal(clientBody({...base, type: 'person', parentId: '2'}).parentId, 2);
});

test('tags are numeric, unique, and sent only when there are some', () => {
  assert.deepEqual(clientBody({...base, tagIds: ['30', 30, 31]}).tagIds, [30, 31]);
  assert.equal('tagIds' in clientBody({...base, tagIds: []}), false);
});

test('fields this Odoo does not allow are omitted from the body', () => {
  const body = clientBody({...base, vat: 'X1', language: 'nl_NL', tagIds: [30]}, {vat: false, tagIds: false});
  assert.equal('vat' in body, false);
  assert.equal('tagIds' in body, false);
  assert.equal(body.language, 'nl_NL');
});
