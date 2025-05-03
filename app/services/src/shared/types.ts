import {User} from "@domain"

export interface RequestorAwareRequest {
  requestor: User
}
