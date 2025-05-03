import {User} from "@domain"
import {Injectable, UnauthorizedException} from "@nestjs/common"
import {PassportStrategy} from "@nestjs/passport"
import {UserService} from "@services"
import {isLeft} from "fp-ts/Either"
import {ExtractJwt, Strategy} from "passport-jwt"

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(private readonly userService: UserService) {
    const jwt_secret = process.env.JWT_SECRET

    if (jwt_secret === undefined) {
      throw new Error("JWT_SECRET is not defined")
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwt_secret,
      ignoreExpiration: false
    })
  }

  async validate(payload: unknown): Promise<User> {
    // This method is invoked after Passport has verified the JWT's signature, hence it must be valid
    if (typeof payload !== "object" || payload === null || !("email" in payload)) {
      throw new UnauthorizedException("Invalid token payload")
    }

    const userEmail = payload.email

    if (typeof userEmail !== "string") {
      throw new UnauthorizedException("Invalid token payload")
    }

    const eitherUser = await this.userService.getUserByIdentifier(userEmail)()

    if (isLeft(eitherUser)) {
      throw new UnauthorizedException("User not found")
    }

    return eitherUser.right
  }
}
