// Keet room-invitation codec (minimal, for pairing-room handshake)
// Uses blind-pairing-core wire protocol + Keet envelope

const crypto = require('crypto')

function createInvitation (roomKeyHex, opts = {}) {
  const seed = opts.seed || crypto.randomBytes(32)
  const seedHex = seed.toString('hex')
  const id = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 64)

  return {
    seed,
    seedHex,
    id,
    invitationId: id,
    discoveryKey: roomKeyHex,
    metadata: {
      canModerate: opts.canModerate !== false,
      canAdmin: opts.canAdmin === true,
      expiration: opts.expires || 0
    },
    response: {
      data: '@keet/room-keys',
      signature: null // filled by bridge writer
    },
    capabilities: {
      discoveryKeyPair: null,
      swarmTopic: null,
      wakeupTopic: null,
      mailbox: null,
      session: null
    }
  }
}

function encodeInviteUrl (invitation) {
  // Minimal: embed seed + id in keet://chat/<z32> format
  // Real implementation needs z32 encoding of seed+id; placeholder uses hex
  const payload = invitation.seedHex.slice(0, 32) + invitation.id.slice(0, 32)
  return 'keet://chat/' + payload
}

module.exports = { createInvitation, encodeInviteUrl }
