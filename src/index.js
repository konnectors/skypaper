const {
  BaseKonnector,
  requestFactory,
  saveBills,
  saveFiles,
  log
} = require('cozy-konnector-libs')

const request = requestFactory({
  cheerio: false,
  json: true,
  jar: true
})

const moment = require('moment')
const stream = require('stream')

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  const token = await authenticate(fields.email, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of orders')
  const ordersNotFiltered = await fetchOrders(token)

  log('info', 'Filtering orders only on Paid (status = 10)')
  const orders = await filterOrders(ordersNotFiltered)

  log('info', 'Parsing list of bills')
  const bills = await parseBills(orders, token)

  log('info', 'Saving Bills to Cozy')
  await saveBills(bills, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['skypaper']
  })

  log('info', 'Parsing list of postcards')
  const files = await parseFiles(orders)
  console.log(files)

  log('info', 'Saving Files to Cozy')
  await saveFiles(files, fields.folderPath, {
    contentType: 'image/jpeg'
  })
}

async function authenticate(email, password) {
  const { token } = await request({
    method: 'POST',
    url: 'https://api.skypaper.io/user/login',
    form: {
      email: email,
      password: password
    }
  })
  return token
}

async function fetchOrders(token) {
  return await request({
    uri: 'https://api.skypaper.io/orders',
    headers: {
      Authorization: 'Bearer ' + token
    }
  })
}

async function filterOrders(orders) {
  var arrOrders = []
  for (let order of orders) {
    if (order.status !== 10) {
      continue
    }
    arrOrders.push(order)
  }
  return arrOrders
}

async function parseBills(arrOrders, token) {
  return arrOrders.map(order => {
    const dateObj = moment.unix(order.updated)
    const pdfStream = new stream.PassThrough()
    const filePipe = request({
      uri: 'https://api.skypaper.io/order/' + order.id + '/invoice',
      headers: {
        Authorization: 'Bearer ' + token
      }
    }).pipe(pdfStream)
    return {
      // fileurl: `https://billing.scaleway.com/invoices/${organization_id}/${start_date}/${id}?format=pdf&x-auth-token=${token}`,
      filestream: filePipe,
      filename: `${dateObj.format('YYYY-MM-DD')}_${order.id}_${
        order.amount
      }€.pdf`,
      vendor: 'Skypaper',
      date: dateObj.toDate(),
      amount: parseFloat(order.amount),
      currency: '€'
    }
  })
}

async function parseFiles(arrOrders) {
  const arrFiles = []

  for (let order of arrOrders) {
    log('debug', 'parseFiles : order > ' + order.id)
    for (let orderItem of order.items) {
      for (let orderItemRecipient of orderItem.recipients) {
        const dateObj = moment.unix(orderItemRecipient.updated)

        const bufferStreamBack = new stream.PassThrough()
        const bufferBack = await request
          .get({
            url: orderItemRecipient.path.back,
            encoding: null,
            headers: {
              Accept: 'image/*, */*'
            }
          })
          .pipe(bufferStreamBack)

        arrFiles.push({
          filestream: bufferBack,
          filename: `${dateObj.format('YYYY-MM-DD')}_${order.id}_${
            orderItemRecipient.recipient.fullName
          }_back.jpg`
        })

        const bufferStreamFront = new stream.PassThrough()
        const bufferFront = await request
          .get({
            url: orderItemRecipient.path.front,
            encoding: null,
            headers: {
              Accept: 'image/*, */*'
            }
          })
          .pipe(bufferStreamFront)
        arrFiles.push({
          filestream: bufferFront,
          filename: `${dateObj.format('YYYY-MM-DD')}_${order.id}_${
            orderItemRecipient.recipient.fullName
          }_front.jpg`
        })
      }
    }
  }
  return arrFiles
}
