"""Portable SHA-512 crypt for Ubuntu account passwords (no plaintext on SD)."""
import hashlib
import secrets

ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'


def password_hash(password, salt=None, rounds=100000):
    if not isinstance(password, str) or not 10 <= len(password) <= 128:
        raise ValueError('รหัสผ่าน Ubuntu ต้องยาว 10–128 ตัวอักษร')
    salt = salt or ''.join(secrets.choice(ALPHABET) for _ in range(16))
    if not 1 <= len(salt) <= 16 or any(c not in ALPHABET for c in salt) or not 5000 <= rounds <= 1000000:
        raise ValueError('Invalid password hash parameters')
    p, s = password.encode(), salt.encode()
    alternate = hashlib.sha512(p+s+p).digest()
    a = hashlib.sha512(p+s)
    a.update((alternate*((len(p)+63)//64))[:len(p)])
    n = len(p)
    while n:
        a.update(alternate if n & 1 else p);n >>= 1
    digest = a.digest()
    dp = hashlib.sha512(p*len(p)).digest()
    pp = (dp*((len(p)+63)//64))[:len(p)]
    ds = hashlib.sha512(s*(16+digest[0])).digest()
    ss = (ds*((len(s)+63)//64))[:len(s)]
    for i in range(rounds):
        h = hashlib.sha512(pp if i & 1 else digest)
        if i % 3:h.update(ss)
        if i % 7:h.update(pp)
        h.update(digest if i & 1 else pp)
        digest = h.digest()
    triples = [(0,21,42),(22,43,1),(44,2,23),(3,24,45),(25,46,4),(47,5,26),(6,27,48),(28,49,7),(50,8,29),(9,30,51),(31,52,10),(53,11,32),(12,33,54),(34,55,13),(56,14,35),(15,36,57),(37,58,16),(59,17,38),(18,39,60),(40,61,19),(62,20,41)]
    result = ''
    for x,y,z in triples:
        value = digest[x]<<16 | digest[y]<<8 | digest[z]
        for _ in range(4):result += ALPHABET[value & 63];value >>= 6
    value = digest[63]
    for _ in range(2):result += ALPHABET[value & 63];value >>= 6
    return f'$6$rounds={rounds}${salt}${result}'
