// Example only: expose the logged-in broker's identity to the assistant.
// Replace with the portal's existing auth/session service.
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class BrokerSessionService {
  producerNumber: string | null = null;  // e.g. from the portal's user profile / token claims
  brokerName: string | null = null;
  language: 'en' | 'fr' | 'nl' = 'en';  // portal UI language; the broker's first message then decides
}
