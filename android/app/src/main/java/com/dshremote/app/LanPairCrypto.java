package com.dshremote.app;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Platform/JDK crypto only. A random 80-bit code authenticates the ephemeral ECDH transcript. */
final class LanPairCrypto {
  private final KeyPair keys;
  private byte[] codeKey;
  private String transcript;

  LanPairCrypto() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    keys = generator.generateKeyPair();
  }
  byte[] publicKey() { return keys.getPublic().getEncoded(); }
  static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
  static String hex(byte[] value) {
    StringBuilder out = new StringBuilder();
    for (byte b : value) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
    return out.toString();
  }
  private static byte[] hmac(byte[] key, byte[] value) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(value);
  }
  String authenticate(String code, String value, String serverProof) throws Exception {
    code = code.replaceAll("[\\s-]", "").toUpperCase(java.util.Locale.ROOT);
    if (!code.matches("[A-F0-9]{20}")) throw new SecurityException("PAIRING_CODE_INVALID");
    codeKey = MessageDigest.getInstance("SHA-256").digest(bytes(code));
    transcript = value;
    String expected = hex(hmac(codeKey, bytes("server\n" + transcript)));
    if (!MessageDigest.isEqual(bytes(expected), bytes(serverProof))) throw new SecurityException("PAIRING_CODE_INVALID");
    return hex(hmac(codeKey, bytes("client\n" + transcript)));
  }
  String decrypt(byte[] serverPublic, byte[] iv, byte[] ciphertext, byte[] tag) throws Exception {
    if (transcript == null || iv.length != 12 || tag.length != 16 || ciphertext.length > 2048) throw new SecurityException("PAIRING_RESPONSE_INVALID");
    KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
    agreement.init(keys.getPrivate());
    agreement.doPhase(KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(serverPublic)), true);
    byte[] prefix = bytes("key\n" + transcript + "\n"), shared = agreement.generateSecret();
    byte[] material = new byte[prefix.length + shared.length];
    System.arraycopy(prefix, 0, material, 0, prefix.length);
    System.arraycopy(shared, 0, material, prefix.length, shared.length);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(hmac(codeKey, material), "AES"), new GCMParameterSpec(128, iv));
    cipher.updateAAD(bytes(transcript));
    byte[] combined = new byte[ciphertext.length + tag.length];
    System.arraycopy(ciphertext, 0, combined, 0, ciphertext.length);
    System.arraycopy(tag, 0, combined, ciphertext.length, tag.length);
    return new String(cipher.doFinal(combined), StandardCharsets.UTF_8);
  }
}
