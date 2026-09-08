const Busboy = require('busboy')

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

// Authenticate before buffering files. Model restrictions are checked again after parsing.
function parseImageUpload(req, res, next) {
  if (!/^multipart\/form-data\b/i.test(req.headers['content-type'] || '')) {
    return res.status(415).json({
      error: { message: 'Image edits require multipart/form-data', type: 'invalid_request_error' }
    })
  }

  let parser
  let totalBytes = 0
  let failed = false
  const fields = Object.create(null)
  const files = []
  const fail = (message, status = 400) => {
    if (failed) {
      return
    }
    failed = true
    req.unpipe(parser)
    req.resume()
    res.status(status).json({ error: { message, type: 'invalid_request_error' } })
  }

  try {
    parser = Busboy({
      headers: req.headers,
      limits: { files: 17, fileSize: 50 * 1024 * 1024, fields: 40, fieldSize: 65536, parts: 57 }
    })
  } catch (_error) {
    return fail('Invalid multipart boundary')
  }

  parser.on('file', (name, stream, info) => {
    const chunks = []
    if (!['image', 'image[]', 'mask'].includes(name)) {
      stream.resume()
      fail('Only image, image[] and mask file fields are supported')
      return
    }
    stream.on('limit', () => fail('Image file exceeds 50 MB', 413))
    stream.on('error', () => fail('Invalid image upload'))
    stream.on('data', (chunk) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_UPLOAD_BYTES) {
        fail('Image upload exceeds 100 MB', 413)
      }
      if (!failed) {
        chunks.push(chunk)
      }
    })
    stream.on('end', () => {
      if (!failed) {
        files.push({
          fieldname: name,
          filename: info.filename || 'image.png',
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks)
        })
      }
    })
  })
  parser.on('field', (name, value, info) => {
    if (info.valueTruncated || info.nameTruncated || Object.hasOwn(fields, name)) {
      fail('Invalid or duplicate image parameter')
      return
    }
    fields[name] = value
  })
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) {
    parser.on(event, () => fail('Too many image upload parts', 413))
  }
  parser.on('error', () => fail('Malformed multipart upload'))
  req.once('aborted', () => {
    failed = true
    parser.destroy()
  })
  parser.on('close', () => {
    if (failed) {
      return
    }
    const images = files.filter((file) => file.fieldname !== 'mask')
    if (!images.length || images.length > 16 || files.some((file) => !file.buffer.length)) {
      return fail('Provide 1 to 16 non-empty image files')
    }
    if (files.filter((file) => file.fieldname === 'mask').length > 1) {
      return fail('Only one mask is supported')
    }
    for (const name of ['n', 'output_compression', 'partial_images']) {
      if (Object.hasOwn(fields, name)) {
        fields[name] = Number(fields[name])
      }
    }
    for (const name of ['async', 'stream']) {
      if (Object.hasOwn(fields, name)) {
        if (!['true', 'false'].includes(fields[name])) {
          return fail(`${name} must be true or false`)
        }
        fields[name] = fields[name] === 'true'
      }
    }
    req.body = { ...fields }
    req.imageFiles = files
    next()
  })
  req.pipe(parser)
}

module.exports = { parseImageUpload }
