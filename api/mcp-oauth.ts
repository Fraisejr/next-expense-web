import { handle } from '../server/mcp/http.ts'
export default { fetch: (request: Request) => handle(request) }
