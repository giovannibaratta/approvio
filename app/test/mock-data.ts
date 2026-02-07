import {
  Prisma,
  PrismaClient,
  User as PrismaUser,
  Agent as PrismaAgent,
  OrganizationAdmin as PrismaOrganizationAdmin,
  WorkflowTemplate as PrismaWorkflowTemplate,
  Workflow as PrismaWorkflow,
  Group as PrismaGroup,
  Space as PrismaSpace,
  RefreshToken as PrismaRefreshToken
} from "@prisma/client"
import {randomBytes} from "crypto"
import {
  ApprovalRuleType,
  Group,
  GroupFactory,
  OrgRole,
  UnconstrainedBoundRole,
  User,
  UserFactory,
  WorkflowStatus
} from "@domain"
import {mapToDomainVersionedUser} from "@external/database/shared"
import {isLeft} from "fp-ts/lib/Either"
// eslint-disable-next-line node/no-unpublished-import
import {Chance} from "chance"
import {
  ConfigProvider,
  ConfigProviderInterface,
  EmailProviderConfig,
  JwtConfig,
  OidcProviderConfig,
  RedisConfig
} from "@external/config"
import {Option} from "fp-ts/lib/Option"
import * as O from "fp-ts/lib/Option"
import {createSha256Hash} from "@utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "@external/database/constants"

const chance = Chance()

// Pre-generated 2048-bit RSA key pairs for testing performance optimization
// WARNING: These keys are for TESTING ONLY and should NEVER be used in production
const TEST_RSA_KEY_POOL = [
  {
    publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo+9N01WCYGVo9sJk8WKr
qjC2LFrD6w+FTczbVwsm1QFZqRYF5a8oshmFELOIul6DKnka/AFX9lQlWT8D32tB
/xy3NU8ASBCsNswYfQnTpDxtVKP4jCc5uy8PSL9W/bmFrQQuYuRzVXnWYx+uqBmK
st8kSyQmorfrgJaeCqDL6rzZFZPUp7L5WtY32HsCfczGPMJdJaUjSQLLQ4z+pm/V
Qb9NQFVVn5pqDG+X0DDLMJ1DjH7WHysL8Ee2qaCc4KC5Pc3TyAlCSZ9kCC6sDttB
DwTUhmQNM0BOEKdPML6ghhSEYo9ugvz1TUZ/VtyPYWfC7bNBzXlYl6X5SRBQZmbg
DwIDAQAB
-----END PUBLIC KEY-----
`,
    privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCj703TVYJgZWj2
wmTxYquqMLYsWsPrD4VNzNtXCybVAVmpFgXlryiyGYUQs4i6XoMqeRr8AVf2VCVZ
PwPfa0H/HLc1TwBIEKw2zBh9CdOkPG1Uo/iMJzm7Lw9Iv1b9uYWtBC5i5HNVedZj
H66oGYqy3yRLJCait+uAlp4KoMvqvNkVk9Snsvla1jfYewJ9zMY8wl0lpSNJAstD
jP6mb9VBv01AVVWfmmoMb5fQMMswnUOMftYfKwvwR7apoJzgoLk9zdPICUJJn2QI
LqwO20EPBNSGZA0zQE4Qp08wvqCGFIRij26C/PVNRn9W3I9hZ8Lts0HNeViXpflJ
EFBmZuAPAgMBAAECggEAKhBNN9zJB1L+C9L1c7qNsa2uENN5Uec5nSzjWwJRhHZE
O06bVMQM/SXvLsniW2/E2DEa626s01fj/XJd3AX5eSw1FkifGd6tUaIs5miPFaUr
qHwqWkv2VEFO+qud9pyT4EEiZd2YemY4zFZkyl1DaYI4Hc+42ie3FdeP1cpMiH5j
U7clZ2nVjLO1kcN5DPAF+i4iIm4z1WZ1DRcBovis8YtXHbDLE7cE8i4ybHQevTfw
/fzpJTTRna2Fev5GHWc56dLyVZF5a3QTnBDOTy3k4Jh/yaxJcbZgojEcJ4pxPIDZ
EzL9C7Fu92rRBzn2DKAhV8pKruFCG4TgFqjObiTJgQKBgQDNuZ+3hEW6/AYRVx/7
MIqRSpmTZIISOASUCuCW3YD4b6uOD9XdV40QoncTkzRRg7Xc5cFuXPSclNcPiOyG
GAUOQbO/m0D15Jsj7ZBfHfSYxFeVbYNARMVGi7Aq6BdbclyT3txmArY1dM/ceXZ0
YG3AtVXTLSBGnIFIp90+8QRb5QKBgQDL/zwS7hhIA5L6VZ4XXyUtPVy56c8uPaeW
KaG1FzVB/kg6TVz979hccL47PxQs7ZgFngDEh4qb5NS3EwGHoDb1gOZBWclJwxNd
0XpWMnstjTaeTYz2XsXFn30icnLEXMKSbpFqcHeL1Cx1xZrCfCH8f0//alXjgbxD
FnfsVDWU4wKBgCS68JY+aojA+IBeEtqxRvw72oGjX0nLcJ3R91lYQO+aWIHrt95m
BEylBSecj6nCH1VKPCftNstCE8e1Ra2HWle6SVJ7cLS2VTCr+KvS2FnyLEUEoXt3
C9XVmOWAPLNaDsdj8evQriGLMpWFpi2PDelrNuCWXP3ecYK8XdcgBww1AoGBAL5X
ctg+7M0U+Kk4BgDMuEWUAdc+wB/nS12jjs0H0Ju5Be/Qi7otdvYaBIYHf23Ea5qi
KRk3Vy/KvmfsBftklKNSGIZVnqmCqalacgnHpIOGRbZDqgmfuG2DOSFRJKDv5GT5
Yhmswv7nhGyHarWZWaTdrekmcOmM/fqjFlae5Df9AoGAWcqhon3StpmY78qpX7ZJ
ye4iY9YfOa2S0kzq1iC3X6B/tPLR8qzlapVYTOskKlB96QrJ+0PHsAf+3apPlWpA
DjhoIPcsVxCdQ/WdvfzRh77V4ZvdJfainOfjwFhxf8dhaRrlKx8LKMln0JDF4yEw
RJ9B8PhK/+M172U4YmQmvhE=
-----END PRIVATE KEY-----
`
  },
  {
    publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlBtKBp86Aaf02MlQiPNF
qgD1AUR2up3VKQ2c05xzfifeW4EZYXcE2QIZE+YM9He2BzsKlRayF8Sw4+yf6Ei6
sfwVK6tHw3F0RPzlj0pv8DnF4Vlzvuxg2WKQzau1D81Wooni5VMaVLEnehsXapuj
UvABL09BuGq0udqgv2nzIWNpsZU1nX6e5MypP5cBsRLYrCqMw2swtqpMdeiWdCAI
y8gnfPSyASuRliHmiYoaExrPwIvHc/XmozIm+1Q95M13kHElwAhoetw242mVGG16
YihshdccaKbh4FGvfqbx5liEP1B/99jlHD6NCAdPq+PoaIHQU2RPl5uHpFdKwyLG
OwIDAQAB
-----END PUBLIC KEY-----
`,
    privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCUG0oGnzoBp/TY
yVCI80WqAPUBRHa6ndUpDZzTnHN+J95bgRlhdwTZAhkT5gz0d7YHOwqVFrIXxLDj
7J/oSLqx/BUrq0fDcXRE/OWPSm/wOcXhWXO+7GDZYpDNq7UPzVaiieLlUxpUsSd6
Gxdqm6NS8AEvT0G4arS52qC/afMhY2mxlTWdfp7kzKk/lwGxEtisKozDazC2qkx1
6JZ0IAjLyCd89LIBK5GWIeaJihoTGs/Ai8dz9eajMib7VD3kzXeQcSXACGh63Dbj
aZUYbXpiKGyF1xxopuHgUa9+pvHmWIQ/UH/32OUcPo0IB0+r4+hogdBTZE+Xm4ek
V0rDIsY7AgMBAAECggEAJglIHqE/5XL8B7zT6QgJKRrr0TKDB3RHbS6oyxPP+WNF
0Nw753MIlK7cP+cCBrrDzeGU2ysj+8Sw5Sg8/QvInrMtwLRRTtlRUfJdBkrIqro7
np85gZv1V37fz2I8st06Va3xzpFkHsIMcGiKv/9Ol5s5wqupJjKJTX3fcKlGHpmk
Ta8nOrYGeDsHz2rpZRUegxgz8mnwpccrd1wf2oSZJSlxko1+az4j26LG6K8zQyze
yTIEnQBCgoha90CfkfDKpiGPRnI4e5JeV6xamWuqEBeBM88pFBLUC/oWgguhxQrG
XEHTMYhkrJSS/v/H8n7g8UuFV5qxeGem666W3t/ZqQKBgQDLFcEopNY3ZWSrSkEo
6BM19/pxWaYO+JRoPsYX2gu/KQhg9knqX8s2PCpAdHzpx8tAxz4EfdUAstDS2VBr
1S+CbGIGKKe/O0tpleb8qMbKY4Vui3py8o0D2psNsjGnUX7W8nUygotxPp0vGP+/
olUESj2ITydYU4okBQ7TYFzfLwKBgQC6sljxJ3xSp/LUG9YOFMhG+AtQOmxGHS5v
zhHxWg2pQ8yWHNHLQR5rejvAQG3J0YmKKp4eetpoOzNLptHnaEVR3MQ5GTPt9IWI
WuZLBUDB+gT4e31Vths0NI7pSKVbmz7VLjC+46COmvnpNAaPQeYVYYDSn6dX/Ccu
H5oyVygmtQKBgQCjSleobXmMyyr5i1f/IzMnJr+pWlLqILd7ZlXzIbBmQQDqrb1b
BTEo55F1h/RUKQBlko5sIB0fVagQkQlX2u87aBgdKZ1PZsbJG+3BY5eLbiAAdYe8
WwhFfAVGKuw/w4hAHm1bcpnaMWVDVE9273h6XZNCQZq6K1mcgrCcBxRFowKBgBFn
2z7wbXjPS6ZWyggaC+oB6hwatkl7Iv8teSLFQIzNU1+TZEPM2GcwyC1OVG4CaQ5G
luNElOQu0MN21A78+6l8KZchMGQ47dIel2XbIYR0KM55xN+e0L53P/Oj4DbALIV3
fvftBOUGsdH6Fbp5bFgF9Rqt484iJgz4yUl0MrwZAoGBAIKLZdUuzGxN99mJqsvP
1ucc6b8Kzi6xAZ6sgkCFai/vtVU8wJpBslv4miFMNhpmPLHBOofJBuUJoErQe5Ku
rLUlWWFUSSwDXhlqCKGY+0qCK2XQ0H6DJlXr4yto6UKHR47QBSioP6SOaBpxmsl0
cHW7lJATOpyCeO3Z50LSObg6
-----END PRIVATE KEY-----
`
  },
  {
    publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw6WKuVM9kXyvrVNePAHD
qBK/VUY/mKUKjTl213yxnwmFhMLbM7mzQmKAZBPYwj9/cr0DF0i0Zv/02OKT+qS4
7HmV7UkqxYFY6eZpEv839zeergEtpIDYsjmXSIswuKp9Yg+08UyUMz14hOl4Oid+
T6MCuae2u/bVsvH1eDJihze+Q6/SFeO1PoT9xn3DcT0+zvEWo9SH42iIHwmrXr5z
OAoUPlMb7EkybQOUumWBQ+S+iDteomqs4FodNFblFjr2XLmXQEoyMsoaJaNFpR5u
ElqWGIT1MzRHTQI36TZl7OJ6SpDi/vUL2gZeomvd6ik3VEAIHBujIDKwNl89DDIr
ywIDAQAB
-----END PUBLIC KEY-----
`,
    privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDDpYq5Uz2RfK+t
U148AcOoEr9VRj+YpQqNOXbXfLGfCYWEwtszubNCYoBkE9jCP39yvQMXSLRm//TY
4pP6pLjseZXtSSrFgVjp5mkS/zf3N56uAS2kgNiyOZdIizC4qn1iD7TxTJQzPXiE
6Xg6J35PowK5p7a79tWy8fV4MmKHN75Dr9IV47U+hP3GfcNxPT7O8Raj1IfjaIgf
CatevnM4ChQ+UxvsSTJtA5S6ZYFD5L6IO16iaqzgWh00VuUWOvZcuZdASjIyyhol
o0WlHm4SWpYYhPUzNEdNAjfpNmXs4npKkOL+9QvaBl6ia93qKTdUQAgcG6MgMrA2
Xz0MMivLAgMBAAECggEAB7gt548Maa5OQ4amZrQOc2tonOWR18+B7D2Ss1Y/rziR
yexi+BZWfNg5xvkY1IfrMEHwmnLAxM706w58QTz48O0BMzoaU8L9Q56sPFbRRKdZ
/Z/ynEAwjKOvaj+CXh7tUI5cbig+hrZhCCQqyBH2hA+N/s5KbFMvw7OT+GNLNkOK
f0f5hZXLlUJIkr/0kUWKV5lpzbNisqgBA17fd3MjrINpVRYY2TKb1L+111ZGCi3z
S5Offsf4Cj6rQQVOqbI39FtJCKj2fp6/OigNgW0PWxlyzUrKYpkeWE+cSmNwduGq
gF8tPDBRSsu6voUW7rUVdS9mwKsymMa8Kos9NpBn5QKBgQD9TxOK+OgvBQv//cx/
l1P0MSFP7HekYl5J+59F2t2IKyQi8Q7X064XoIzljwRdd8L7newQi4oq2R8cc6y4
zxsCNYU0RSpYrQ0xFqn8mf3m6c5zj+LTAQaYOnO29sJsGKrK0t/HakD8n83NYVJE
Gs4d1Emw4qefKKRhGuGPQKTjtwKBgQDFuaREUZpnerYCUXWeWT+1Qnl0/wVVFkfN
91alPWVaS70nKJgCwmFZ7QfkrL7wXvv6gGt67gawxL9Esq7beehVUK3Fzks2m6z8
gVd3/Q/7v86oJQuzV6qcuzWOynNMJkbC+8ZEUQwn3hC/oMjN41o5qj/nk9AgSKu8
B8QgKSVAjQKBgGJ/uU209DQ0djIY8sg6g/7Ui+uUPAHD7n4+RfTX4oTsoaSkr+zk
9zFg0OkC7+OYik1lX0IfwJ5gx2Q85tEGV65IOX/V1V2eDR8lfPwotT5xdEIjlUQP
hgzzzcM7uOZnwSIVVccpXhPd4B0Y1vB8q+GVhwItYJjXKPRJi6Q0sumJAoGAUutT
dEM0mYjgo4A97zZGfWFvRh1cwx4g5sN/VrS0uHVi0fU4KpAR+4Bn+wJm4K80xQzu
BhOkQqWAAPNeWTR6tqyq83VcHX6TwSEM6Yj7FvyNUf6XNZLiPfBUuZk1WQ4ERukH
cMb8bgu2wmZPT+i0gdJgEmHuuls/ig9HtKUMtlECgYBxgWCkwRIFzKPbZACJYQUz
gz4SE2+CaHzjIq3No3CkBu7QXNcdK+rmRzpg9i0zD6T/0WjqSMDvBgbKE8ZZS1pY
WV10LSRqcn8I6GUaZ2q+IwOjh+1aXbNgFIt9ONO6rTC7R/HLFujKGb+Rg/0PnG2O
VLwkyx5dlIaDYHRqPniqRA==
-----END PRIVATE KEY-----
`
  },
  {
    publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkhAO8gWyv2iJBbzVQ+IV
GJ6F+tvqyxJld7RjsALjboqUBV8DKaYz1/YDTczxZ1kWQvrm2kJWdOUQZvBwMeNT
nsTZ5bU0xJq2hA4KP1W69DVFHiCFyzNZskOh9BrQwPFqRHzR/9IfqxMj1sbHfBl1
tBSC65ygiG1g5Iy4WXizXskQFr9JzFqaky2YakE/pGJQta/JFVNVA8EGYtGQr7fj
R6ElrdIQUTgBFIiVtvH7JHICQ3Gp6uANB4MtvR+kVHEXUJflH7e1EZaRAYrBvH/+
GnRpuo7ZxIySMiT/UfdOHWBhlYfI4tdJsJXdWHyL/INXd+FKXx3HZ7QwA43eCNMe
OQIDAQAB
-----END PUBLIC KEY-----
`,
    privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCSEA7yBbK/aIkF
vNVD4hUYnoX62+rLEmV3tGOwAuNuipQFXwMppjPX9gNNzPFnWRZC+ubaQlZ05RBm
8HAx41OexNnltTTEmraEDgo/Vbr0NUUeIIXLM1myQ6H0GtDA8WpEfNH/0h+rEyPW
xsd8GXW0FILrnKCIbWDkjLhZeLNeyRAWv0nMWpqTLZhqQT+kYlC1r8kVU1UDwQZi
0ZCvt+NHoSWt0hBROAEUiJW28fskcgJDcanq4A0Hgy29H6RUcRdQl+Uft7URlpEB
isG8f/4adGm6jtnEjJIyJP9R904dYGGVh8ji10mwld1YfIv8g1d34UpfHcdntDAD
jd4I0x45AgMBAAECggEAG6/tlVUdMAlZx/umlYqaoyMRlJ7xX/MpxsosB2ZUxFSC
gI4lJFT8CNj6gVny/Ls3bBTxg7gFeX0eYdT7/4jvBe6cu11hFk+Zf2jF6oGOwdID
OxXBJuah/xew8HvQzHI2yaq7h/nFxQEIzyK5F74fwLYOpyj2iUXqkwhVvagSoEnF
cCA9Rwe+uP53ke47148/uZJKmu8KMmitSumAvh6TzXExavevY62IKc9XX6nysJgN
nLCVF4uYynpOsP10n15TfbI4hwQhdvnn73XtEX01BGH2Umm7fQGYToFfgic98Y3B
OWIQgvo5mMbng0PtRllwVqUo2aFv8qHykNtn4vgN8QKBgQDEdmhNghibnUqBtRLv
0JyAN8HIEa0O9pbj7WtPNMmS3u5iP1LtV5MZJegbD7GWwE9GSAmu9xUoFwF255CG
ON0y4YhhKUOK9tWm4ljTkr28QF5bIiWzGwREPTR8a+EF6xIF+WJVNYmPvCML2axl
N+Q3nPwZf3SukYhktfZULroHhQKBgQC+U6B2J2k3TiSGU8vrGtLVB3XHiW/jpOAe
4abi4aum+nOGCk22vXPyedD766jxyOiuKPwWO7eZadvi/R8Qp69yWnWo0toeITIm
x/f+SjA/I+aQaU1aszyRTFcSX8Frr5T2OJFPjVkB1PNmUK+KRfTlnj0hkSmsIjE1
rh2M+fpoJQKBgE88clTQY5xfk+08WqbePEB6PG20s1eVnMXQu7b2U1YpE3wMjiWr
bGh4IWTIr5ddeJuf8kfe32mL3ctXGbMIvC4JSDfnrJYfd4wXPjwWsu96BpQ68XmL
K+1ZwhFscRUx+dLvAfnb3d9awcfFwwIPyLulVQfzn9vIVnpH6VGKhv0BAoGAG7MM
DWYa+AOVaT9U1DipKnvVdl7YO+dI/vWUVjzFwJ1+pqllOg1EjKuR8LgRdG7q/j3U
wl+ajudLKzPvi3r8G8ZyjUlymSP3qpE71HRzpRzSd3371hFz5SmZGoF5IvUA1vzQ
mSVXKN8XNXLUuWkJBUoMV5BK4lRvmQJoJpZTDUkCgYEAjm9L+0aOM3twQZmpdc09
7nz4H+dVyYDIglLjOK9KDn6a3E+ga5B1Ue6rsOlLOI6ly2jyAsRu6Mt0iGDHyyhq
WPhrkMXnJOKHooQktyzJfItzDkcIiOYMOUleDnhF3Hw9jf3wz9o+geJC3Pey14PX
OoopD2yZnS0i+pacrIfFQeY=
-----END PRIVATE KEY-----
`
  }
] as const

/**
 * MockKeyPool provides pre-generated RSA key pairs for testing performance optimization.
 *
 * PERFORMANCE IMPROVEMENT: Using this pool eliminates the 2-3 second RSA key generation
 * per agent creation, reducing test suite execution time.
 *
 * WARNING: These keys are for TESTING ONLY and should NEVER be used in production.
 *
 * The pool contains pre-generated 2048-bit RSA key pairs in PEM format.
 * Keys are selected using ChanceJS for deterministic test behavior.
 */
export class MockKeyPool {
  /**
   * Gets a random key pair from the pre-generated pool using ChanceJS.
   *
   * @param chanceInstance - ChanceJS instance for deterministic selection
   * @returns RSA key pair with publicKey and privateKey in PEM format
   * @throws Error if pool is exhausted (safety check)
   */
  static getRandomKeyPair(chanceInstance: Chance.Chance = chance): {publicKey: string; privateKey: string} {
    return chanceInstance.pickone(TEST_RSA_KEY_POOL)
  }

  /**
   * Gets a specific key pair by index for deterministic testing.
   *
   * @param index - Index of the key pair to retrieve (0-19)
   * @returns RSA key pair with publicKey and privateKey in PEM format
   * @throws Error if index is out of bounds
   */
  static getKeyPairByIndex(index: number): {publicKey: string; privateKey: string} {
    if (index < 0 || index >= TEST_RSA_KEY_POOL.length) {
      throw new Error(`MockKeyPool: Index ${index} is out of bounds. Pool size: ${TEST_RSA_KEY_POOL.length}`)
    }

    return TEST_RSA_KEY_POOL[index] as {publicKey: string; privateKey: string}
  }
}

export class MockConfigProvider implements ConfigProviderInterface {
  dbConnectionUrl: string
  emailProviderConfig: Option<EmailProviderConfig>
  oidcConfig: OidcProviderConfig
  jwtConfig: JwtConfig
  redisConfig: RedisConfig

  private constructor(
    originalProvider?: ConfigProvider,
    mocks: {dbConnectionUrl?: string; emailProviderConfig?: EmailProviderConfig; redisPrefix?: string} = {}
  ) {
    const provider: ConfigProviderInterface = originalProvider ?? {
      dbConnectionUrl: "postgresql://test:test@localhost:5433/postgres?schema=public",
      emailProviderConfig: O.none,
      oidcConfig: {
        issuerUrl: "http://localhost:4011",
        clientId: "integration-test-client-id",
        clientSecret: "integration-test-client-secret",
        redirectUri: "http://localhost:3000/auth/callback",
        allowInsecure: true
      },
      jwtConfig: {
        secret: "test-jwt-secret-for-integration-tests",
        trustedIssuers: ["idp.test.localhost"],
        issuer: "idp.test.localhost",
        audience: "approvio.test.localhost"
      },
      redisConfig: {
        host: "localhost",
        port: 1234,
        db: 5
      }
    }

    this.dbConnectionUrl = mocks.dbConnectionUrl || provider.dbConnectionUrl
    this.emailProviderConfig =
      mocks.emailProviderConfig !== undefined ? O.some(mocks.emailProviderConfig) : provider.emailProviderConfig
    this.oidcConfig = provider.oidcConfig
    this.jwtConfig = provider.jwtConfig
    this.redisConfig =
      mocks.redisPrefix !== undefined ? {...provider.redisConfig, prefix: mocks.redisPrefix} : provider.redisConfig
  }

  static fromDbConnectionUrl(dbConnectionUrl: string, redisPrefix?: string): MockConfigProvider {
    const realProvider = new ConfigProvider()
    return new MockConfigProvider(realProvider, {dbConnectionUrl, redisPrefix})
  }

  static fromOriginalProvider(
    mocks: {dbConnectionUrl?: string; emailProviderConfig?: EmailProviderConfig; redisPrefix?: string} = {}
  ): MockConfigProvider {
    const provider = new ConfigProvider()
    return new MockConfigProvider(provider, mocks)
  }
}

type PrismaUserWithOrgAdmin = PrismaUser & {
  organizationAdmins: PrismaOrganizationAdmin | null
}

export function createMockUserDomain(overrides?: {email?: string}): User {
  const randomUser = UserFactory.newUser({
    email: overrides?.email ?? chance.email(),
    displayName: chance.name(),
    orgRole: OrgRole.MEMBER
  })

  if (isLeft(randomUser)) throw new Error("Failed to create user")

  return randomUser.right
}

export function createMockUserPrismaPayload(
  overrides?: Partial<Omit<Prisma.UserCreateInput, "roles">> & {
    roles?: ReadonlyArray<UnconstrainedBoundRole>
  }
): Prisma.UserCreateInput {
  const randomUser: Prisma.UserCreateInput = {
    id: chance.guid({
      version: 4
    }),
    displayName: chance.name(),
    email: chance.email(),
    occ: POSTGRES_BIGINT_LOWER_BOUND,
    createdAt: new Date()
  }

  const {roles, ...userOverrides} = overrides || {}

  return {...randomUser, ...userOverrides, roles: roles ? JSON.parse(JSON.stringify(roles)) : null}
}

export async function createMockUserInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.UserCreateInput, "roles">> & {
    orgAdmin?: boolean
    roles?: ReadonlyArray<UnconstrainedBoundRole>
  }
): Promise<PrismaUserWithOrgAdmin> {
  const {orgAdmin, ...userOverrides} = overrides || {}
  const payload = createMockUserPrismaPayload(userOverrides)
  const user = await prisma.user.create({data: payload})

  if (orgAdmin) {
    await prisma.organizationAdmin.create({
      data: {
        createdAt: new Date(),
        email: user.email,
        id: chance.guid()
      }
    })
  }

  // Return user with organizationAdmin relationship included
  const userWithOrgAdmin = await prisma.user.findUnique({
    where: {id: user.id},
    include: {organizationAdmins: true}
  })

  if (!userWithOrgAdmin) throw new Error("Unable to fetch created user")

  return userWithOrgAdmin
}

export async function createDomainMockUserInDb(
  prisma: PrismaClient,
  overrides?: Parameters<typeof createMockUserInDb>[1]
): Promise<User> {
  const dbUser = await createMockUserInDb(prisma, overrides)
  const eitherUser = mapToDomainVersionedUser(dbUser)
  if (isLeft(eitherUser)) throw new Error("Unable to create mock user")
  return eitherUser.right
}

/**
 * Creates a mock agent in the database with performance-optimized key generation.
 *
 * PERFORMANCE OPTIMIZATION: Uses pre-generated RSA key pairs from MockKeyPool
 * instead of generating new 4096-bit keys on-demand.
 *
 * @param prisma - Prisma client for database operations
 * @param overrides - Optional overrides for agent properties
 * @param overrides.agentName - Custom agent name (auto-generated if not provided)
 * @param overrides.keyPair - Custom RSA key pair (uses MockKeyPool if not provided)
 * @returns Promise<PrismaAgent> - The created agent record
 */
export async function createMockAgentInDb(
  prisma: PrismaClient,
  overrides?: {
    agentName?: string
    keyPair?: {publicKey: string; privateKey: string}
  }
): Promise<PrismaAgent> {
  const agentName = overrides?.agentName || `test-agent-${chance.word()}`

  // Use provided keys or get from the pre-generated pool for performance
  const keyPair = overrides?.keyPair || MockKeyPool.getRandomKeyPair(chance)

  // Create agent with optimized key generation
  const data: Prisma.AgentCreateInput = {
    id: chance.guid({version: 4}),
    agentName,
    base64PublicKey: Buffer.from(keyPair.publicKey).toString("base64"),
    createdAt: new Date(),
    occ: POSTGRES_BIGINT_LOWER_BOUND
  }

  return await prisma.agent.create({data})
}

export function createMockGroupDomain(overrides?: {name?: string}): Group {
  const randomGroup = GroupFactory.newGroup({
    name: overrides?.name ?? chance.word(),
    description: chance.sentence()
  })

  if (isLeft(randomGroup)) throw new Error("Failed to create group")

  return randomGroup.right
}

export async function createTestGroup(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.GroupCreateInput, "id" | "occ">>
): Promise<PrismaGroup> {
  const randomGroup: Prisma.GroupCreateInput = {
    id: chance.guid({version: 4}),
    name: `test-group-${chance.word()}`,
    description: chance.sentence(),
    createdAt: new Date(),
    updatedAt: new Date(),
    occ: 1
  }

  const data: Prisma.GroupCreateInput = {
    ...randomGroup,
    ...overrides
  }

  return await prisma.group.create({data})
}

export async function createMockWorkflowTemplateInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.WorkflowTemplateCreateInput, "id" | "occ" | "spaces">> & {
    spaceId?: string
  }
): Promise<PrismaWorkflowTemplate> {
  const dates = generate_consistent_dates_for_workflow_template(overrides)

  const spaceId = overrides?.spaceId ?? (await createMockSpaceInDb(prisma)).id

  const randomTemplate: Prisma.WorkflowTemplateCreateInput = {
    id: chance.guid({
      version: 4
    }),
    name: chance.guid({version: 4}),
    description: chance.sentence(),
    approvalRule: {
      type: ApprovalRuleType.GROUP_REQUIREMENT,
      groupId: chance.guid({
        version: 4
      }),
      minCount: 1
    },
    actions: [],
    defaultExpiresInHours: chance.integer({min: 1, max: 168}), // 1 hour to 1 week
    status: "ACTIVE",
    allowVotingOnDeprecatedTemplate: true,
    version: "latest",
    occ: 1,
    spaces: {
      connect: {
        id: spaceId
      }
    },
    createdAt: dates.createdAt,
    updatedAt: dates.updatedAt
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {spaceId: _, ...overridesWithoutSpaceId} = overrides ?? {}

  const data: Prisma.WorkflowTemplateCreateInput = {
    ...randomTemplate,
    ...overridesWithoutSpaceId
  }

  const template = await prisma.workflowTemplate.create({data})
  return template
}

export async function createMockWorkflowInDb(
  prisma: PrismaClient,
  overrides: {
    name: string
    description?: string
    status?: WorkflowStatus
    workflowTemplateId?: string
    spaceId?: string
    expiresAt?: Date | "active" | "expired"
  }
): Promise<PrismaWorkflow> {
  let workflowId: string | undefined = overrides.workflowTemplateId

  if (!workflowId) {
    const template = await createMockWorkflowTemplateInDb(prisma, {spaceId: overrides.spaceId})
    workflowId = template.id
  }

  const dates = generate_consistent_dates_for_workflow(overrides.expiresAt)

  const workflow = await prisma.workflow.create({
    data: {
      id: chance.guid({version: 4}),
      name: overrides.name,
      description: overrides.description,
      status: overrides.status ?? WorkflowStatus.APPROVED,
      recalculationRequired: false,
      workflowTemplateId: workflowId,
      createdAt: dates.createdAt,
      updatedAt: dates.updatedAt,
      expiresAt: dates.expiresAt,
      occ: 1n
    }
  })
  return workflow
}

function generate_consistent_dates_for_workflow(optionalExpiresAt: Date | "active" | "expired" | undefined): {
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
} {
  const now = new Date()

  // Default: createdAt is a few minutes in the past, updatedAt is slightly after createdAt, expiresAt is in the future
  if (optionalExpiresAt === undefined) {
    const createdAt = new Date(now.getTime() - 1000 * 60 * 5) // 5 minutes ago
    const updatedAt = new Date(createdAt.getTime() + 1000 * 10) // 10 seconds after creation
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30) // 30 days from now
    return {expiresAt, createdAt, updatedAt}
  }

  // Specific expiresAt date provided
  if (typeof optionalExpiresAt !== "string") {
    const expiresAt = optionalExpiresAt
    const createdAt = new Date(now.getTime() - 1000 * 60 * 5) // 5 minutes ago
    const updatedAt = new Date(createdAt.getTime() + 1000 * 10) // 10 seconds after creation
    return {expiresAt, createdAt, updatedAt}
  }

  // Active workflow: expiresAt in the future
  if (optionalExpiresAt === "active") {
    const createdAt = new Date(now.getTime() - 1000 * 60 * 5) // 5 minutes ago
    const updatedAt = new Date(createdAt.getTime() + 1000 * 10) // 10 seconds after creation
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30) // 30 days from now
    return {expiresAt, createdAt, updatedAt}
  }

  // Expired workflow: expiresAt in the past
  const expiresAt = new Date(now.getTime() - 1000 * 60 * 60 * 24) // 1 day ago
  const createdAt = new Date(expiresAt.getTime() - 1000 * 60 * 60 * 24 * 30) // 30 days before expiry
  const updatedAt = new Date(createdAt.getTime() + 1000 * 60) // 1 minute after creation
  return {expiresAt, createdAt, updatedAt}
}

function generate_consistent_dates_for_workflow_template(
  overrides?: Partial<Pick<Prisma.WorkflowTemplateCreateInput, "updatedAt" | "createdAt">>
): {
  createdAt: Date | string
  updatedAt: Date | string
} {
  if (overrides?.updatedAt && overrides?.createdAt && overrides.updatedAt < overrides.createdAt)
    throw new Error("Updated at must be after created at")

  if (overrides?.updatedAt && overrides?.createdAt)
    return {createdAt: overrides.createdAt, updatedAt: overrides.updatedAt}
  if (overrides?.updatedAt) return {createdAt: randomDateBefore(overrides.updatedAt), updatedAt: overrides.updatedAt}
  if (overrides?.createdAt) return {createdAt: overrides.createdAt, updatedAt: randomDateAfter(overrides.createdAt)}

  const now = new Date(Date.now())
  const updatedAt = randomDateBefore(now)
  const createdAt = randomDateBefore(updatedAt)
  return {createdAt, updatedAt}
}

export function randomDateBefore(date: Date | string): Date {
  if (typeof date === "string") date = new Date(date)
  return new Date(date.getTime() - chance.integer({min: 1, max: 1000 * 60 * 60 * 24 * 30}))
}

export function randomDateAfter(date: Date | string): Date {
  if (typeof date === "string") date = new Date(date)
  return new Date(date.getTime() + chance.integer({min: 1, max: 1000 * 60 * 60 * 24 * 30}))
}

export async function createMockGroupInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.GroupCreateInput, "id" | "occ">>
): Promise<PrismaGroup> {
  const randomGroup: Prisma.GroupCreateInput = {
    id: chance.guid({version: 4}),
    name: chance.word({length: 10}) + "-" + chance.integer({min: 1, max: 1000}),
    description: chance.sentence(),
    createdAt: new Date(),
    updatedAt: new Date(),
    occ: 1
  }

  const data: Prisma.GroupCreateInput = {
    ...randomGroup,
    ...overrides
  }

  const group = await prisma.group.create({data})
  return group
}

export async function createMockSpaceInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.SpaceCreateInput, "id" | "occ">>
): Promise<PrismaSpace> {
  const randomSpace: Prisma.SpaceCreateInput = {
    id: chance.guid({version: 4}),
    name: chance.company(),
    description: chance.sentence(),
    createdAt: new Date(),
    updatedAt: new Date(),
    occ: 1n
  }

  const data: Prisma.SpaceCreateInput = {
    ...randomSpace,
    ...overrides
  }

  const space = await prisma.space.create({data})
  return space
}

/**
 * Creates a mock refresh token in the database for a given user.
 *
 * @param prisma - Prisma client for database operations
 * @param params - Parameters for creating the refresh token
 * @param params.userId - The user ID to associate the token with
 * @param params.status - Token status (active, used, revoked)
 * @param params.expiresInSeconds - How long until the token expires (default: 3600)
 * @param params.createdAt - When the token was created (default: now)
 * @param params.familyId - Family ID for token revocation (auto-generated if not provided)
 * @returns Promise<{token: PrismaRefreshToken; plainToken: string; familyId: string}> - The created token and plain token value
 */
export async function createMockRefreshTokenInDb(
  prisma: PrismaClient,
  params: {
    userId?: string
    agentId?: string
    status: "active" | "used" | "revoked"
    expiresInSeconds?: number
    createdAt?: Date
    familyId?: string
  }
): Promise<{token: PrismaRefreshToken; plainToken: string; tokenId: string; familyId: string}> {
  if (!params.userId && !params.agentId) throw new Error("Must provide either userId or agentId")

  const plainToken = randomBytes(32).toString("hex")
  const tokenHash = createSha256Hash(plainToken)
  const familyId = params.familyId || chance.guid()
  const createdAt = params.createdAt || chance.date()
  const expiresAt = new Date(createdAt.getTime() + (params.expiresInSeconds || chance.integer({min: 1800})) * 1000)

  // Prepare additional data for status-specific fields
  const extraData: {usedAt?: Date | null; nextTokenId?: string | null} = {}
  if (params.status === "used") {
    extraData.usedAt = new Date(createdAt.getTime() + 1000) // Used 1 second after creation
    extraData.nextTokenId = chance.guid()
  }

  const token = await prisma.refreshToken.create({
    data: {
      id: chance.guid(),
      tokenHash,
      familyId,
      userId: params.userId,
      agentId: params.agentId,
      status: params.status,
      expiresAt,
      createdAt,
      occ: POSTGRES_BIGINT_LOWER_BOUND,
      ...extraData
    }
  })

  return {token, plainToken, tokenId: token.id, familyId}
}

/**
 * Creates a user with a refresh token in the database.
 *
 * @param prisma - Prisma client for database operations
 * @param params - Parameters for creating user and token
 * @param params.expiresInSeconds - How long until the token expires (default: 3600)
 * @param params.status - Token status (default: "active")
 * @param params.createdAt - When the token was created (default: now)
 * @param params.userOverrides - Overrides for user creation
 * @returns Promise<{user: User; plainToken: string; refreshToken: PrismaRefreshToken; familyId: string}> - The created user and token
 */
export async function createUserWithRefreshToken(
  prisma: PrismaClient,
  params: {
    tokenOverrides?: {
      expiresInSeconds?: number
      status?: "active" | "used" | "revoked"
      createdAt?: Date
    }
    userOverrides?: Parameters<typeof createDomainMockUserInDb>[1]
  } = {}
): Promise<{
  user: User
  token: {
    plainToken: string
    refreshToken: PrismaRefreshToken
    familyId: string
    tokenId: string
  }
}> {
  const user = await createDomainMockUserInDb(prisma, params.userOverrides)

  const {
    token: refreshToken,
    plainToken,
    tokenId,
    familyId
  } = await createMockRefreshTokenInDb(prisma, {
    userId: user.id,
    status: params.tokenOverrides?.status || "active",
    expiresInSeconds: params.tokenOverrides?.expiresInSeconds,
    createdAt: params.tokenOverrides?.createdAt
  })

  return {
    user,
    token: {
      plainToken,
      refreshToken,
      familyId,
      tokenId
    }
  }
}
