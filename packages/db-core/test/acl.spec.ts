import { expect } from 'aegir/chai'
import { checkPermission, hasAtLeast, createDefaultAcl } from '../src/collection/acl.js'
import type { CollectionAcl, Permission } from '../src/collection/struct.js'

describe('Collection ACL', () => {
	describe('hasAtLeast', () => {
		it('should accept equal permission levels', () => {
			expect(hasAtLeast('read', 'read')).to.be.true
			expect(hasAtLeast('write', 'write')).to.be.true
			expect(hasAtLeast('admin', 'admin')).to.be.true
		})

		it('should accept higher permission levels', () => {
			expect(hasAtLeast('write', 'read')).to.be.true
			expect(hasAtLeast('admin', 'read')).to.be.true
			expect(hasAtLeast('admin', 'write')).to.be.true
		})

		it('should reject insufficient permission levels', () => {
			expect(hasAtLeast('read', 'write')).to.be.false
			expect(hasAtLeast('read', 'admin')).to.be.false
			expect(hasAtLeast('write', 'admin')).to.be.false
		})
	})

	describe('checkPermission', () => {
		it('should treat undefined ACL as open (write) access', () => {
			expect(checkPermission(undefined, 'peer-a', 'read')).to.be.true
			expect(checkPermission(undefined, 'peer-a', 'write')).to.be.true
			expect(checkPermission(undefined, 'peer-a', 'admin')).to.be.false
		})

		it('should use defaultPermission for unlisted peers', () => {
			const acl: CollectionAcl = {
				defaultPermission: 'read',
				grants: { 'peer-a': 'admin' },
			}
			expect(checkPermission(acl, 'peer-b', 'read')).to.be.true
			expect(checkPermission(acl, 'peer-b', 'write')).to.be.false
		})

		it('should fall back to write when defaultPermission is absent', () => {
			const acl: CollectionAcl = {
				grants: { 'peer-a': 'read' },
			}
			expect(checkPermission(acl, 'peer-b', 'write')).to.be.true
			expect(checkPermission(acl, 'peer-b', 'admin')).to.be.false
		})

		it('should honor explicit grants', () => {
			const acl: CollectionAcl = {
				defaultPermission: 'read',
				grants: {
					'peer-admin': 'admin',
					'peer-writer': 'write',
					'peer-reader': 'read',
				},
			}
			expect(checkPermission(acl, 'peer-admin', 'admin')).to.be.true
			expect(checkPermission(acl, 'peer-admin', 'write')).to.be.true
			expect(checkPermission(acl, 'peer-writer', 'write')).to.be.true
			expect(checkPermission(acl, 'peer-writer', 'admin')).to.be.false
			expect(checkPermission(acl, 'peer-reader', 'read')).to.be.true
			expect(checkPermission(acl, 'peer-reader', 'write')).to.be.false
		})
	})

	describe('createDefaultAcl', () => {
		it('should grant admin to the creator', () => {
			const acl = createDefaultAcl('creator-peer')
			expect(acl.grants['creator-peer']).to.equal('admin')
		})

		it('should set default permission to read', () => {
			const acl = createDefaultAcl('creator-peer')
			expect(acl.defaultPermission).to.equal('read')
		})

		it('should allow creator full access', () => {
			const acl = createDefaultAcl('creator-peer')
			expect(checkPermission(acl, 'creator-peer', 'admin')).to.be.true
			expect(checkPermission(acl, 'creator-peer', 'write')).to.be.true
			expect(checkPermission(acl, 'creator-peer', 'read')).to.be.true
		})

		it('should restrict other peers to read', () => {
			const acl = createDefaultAcl('creator-peer')
			expect(checkPermission(acl, 'other-peer', 'read')).to.be.true
			expect(checkPermission(acl, 'other-peer', 'write')).to.be.false
			expect(checkPermission(acl, 'other-peer', 'admin')).to.be.false
		})
	})
})
