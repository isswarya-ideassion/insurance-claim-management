/**
 * Validates and replaces req.body / req.query / req.params with parsed values.
 * Express 5 exposes req.query as a getter, so parsed query values live on req.validatedQuery.
 */
export function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    if (params) req.params = params.parse(req.params)
    if (query) req.validatedQuery = query.parse(req.query)
    if (body) req.body = body.parse(req.body ?? {})
    next()
  }
}
