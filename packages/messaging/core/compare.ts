/**
 * Code-unit string order — locale-independent, identical on every host.
 * `localeCompare` follows the host's locale, so two machines can sort the
 * same rows differently; anything documented as byte-identical sorts with
 * this instead.
 */
export const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};
