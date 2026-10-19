/** 实例：电脑端页面就在实例的地址下；手机端所有实例共用一个页面地址，取当前实例 */
export function instanceKey(): string {
  const mobile = (window as { __cloudsshMobile?: { state?: { current?: { baseUrl?: string } } | null } }).__cloudsshMobile;
  const base = mobile?.state?.current?.baseUrl;
  try {
    return base ? new URL(base).host : location.host;
  } catch {
    return location.host;
  }
}
