import { ok } from '../../utils/http.js'
import * as service from './reports.service.js'

export async function summary(req, res) {
  ok(res, await service.buildReports(req.ctx, req.validatedQuery))
}
