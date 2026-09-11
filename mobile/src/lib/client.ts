/**
 * Chooses the one {@link ApiClient} the app uses.
 *
 * `EXPO_PUBLIC_DEMO=1` selects the fixture client (spec §13) so screens run
 * with no Worker deployed; anything else talks to {@link BACKEND_BASE_URL}.
 * The decision is made exactly once, here, so no screen ever branches on it.
 *
 *   npx expo start                  -> real client
 *   EXPO_PUBLIC_DEMO=1 npx expo start -> fixture client
 */

import type { ApiClient } from '@/lib/api';
import { createClient } from '@/lib/api';
import { createFixtureClient } from '@/lib/fixture-client';
import { BACKEND_BASE_URL, DEMO_MODE } from '@/lib/types';

export const apiClient: ApiClient = DEMO_MODE
  ? createFixtureClient()
  : createClient(BACKEND_BASE_URL);
