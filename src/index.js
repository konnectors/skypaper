process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://b367f3b005914efca75ab6404887cca3@sentry.cozycloud.cc/104'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  saveFiles,
  log,
  errors
} = require('cozy-konnector-libs')

const request = requestFactory({
  cheerio: false,
  json: true,
  jar: true
})

const moment = require('moment')

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

  log('info', 'Filtering orders')
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

  log('info', 'Saving Files to Cozy')
  await saveFiles(files, fields.folderPath, {
    contentType: 'image/jpeg'
  })
}

async function authenticate(email, password) {
  try {
    const { token } = await request({
      method: 'POST',
      url: 'https://api.skypaper.io/user/login',
      form: {
        email: email,
        password: password
      }
    })
    return token
  } catch (err) {
    // 401 : User disabled - Invalid credentials
    // 404 : User not found
    if (err.statusCode === 401 || err.statusCode === 404) {
      throw new Error(errors.LOGIN_FAILED)
    } else {
      throw new Error(errors.VENDOR_DOWN)
    }
  }
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
    // Only paid orders
    if (order.status !== 10) {
      continue
    }
    arrOrders.push(order)
  }
  return arrOrders
}

async function parseBills(arrOrders, token) {
  return arrOrders
    .filter(order => {
      return order.hasInvoice
    })
    .map(order => {
      const dateObj = moment.unix(order.updated)
      return {
        fileurl: 'https://api.skypaper.io/order/' + order.id + '/invoice',
        requestOptions: {
          headers: {
            Authorization: 'Bearer ' + token
          }
        },
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
      // Order with postcards (& not creditpacks)
      if (!orderItem.recipients) {
        continue
      }
      for (let orderItemRecipient of orderItem.recipients) {
        const dateObj = moment.unix(orderItemRecipient.updated)

        arrFiles.push(
          {
            fileurl: orderItemRecipient.path.back,
            filename: `${dateObj.format('YYYY-MM-DD')}_${order.id}_${
              orderItemRecipient.recipient.fullName
            }_back.jpg`,
            requestOptions: {
              headers: {
                Accept: 'image/*, */*'
              }
            }
          },
          {
            fileurl: orderItemRecipient.path.front,
            filename: `${dateObj.format('YYYY-MM-DD')}_${order.id}_${
              orderItemRecipient.recipient.fullName
            }_front.jpg`,
            requestOptions: {
              headers: {
                Accept: 'image/*, */*'
              }
            }
          }
        )
      }
    }
  }
  return arrFiles
}
