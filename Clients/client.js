require('dotenv').config();
const { ethers } = require('ethers');

async function makePayment() {
  console.log('AI Agent starting payment request...\n');

  // Step 1: Try to access the resource (will get 402)
  console.log('Requesting data from server...');
  const response = await fetch(`${process.env.SERVER_URL}/api/data`);

  console.log(`Response status: ${response.status}`);

  if (response.status === 402) {
    const paymentRequirements = await response.json();

    console.log('\nPayment Required:');
    console.log(`   Pay to: ${paymentRequirements.payTo}`);
    console.log(`   Amount: ${paymentRequirements.amount} (0.01 USDC)`);
    console.log(`   Network: ${paymentRequirements.network}`);

    // Step 2: Set up wallet (signing only, no broadcasting)
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.CLIENT_PRIVATE_KEY, provider);
    console.log(`Client wallet: ${wallet.address}`);

    // Step 3: Create EIP-712 authorization
    const domain = {
      name: paymentRequirements.extra.name,
      version: paymentRequirements.extra.version,
      chainId: parseInt(process.env.CHAIN_ID),
      verifyingContract: paymentRequirements.asset
    };

    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    };

    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const authorization = {
      from: wallet.address,
      to: ethers.getAddress(paymentRequirements.payTo),
      value: paymentRequirements.amount,
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + paymentRequirements.maxTimeoutSeconds,
      nonce
    };

    console.log('\nCreating EIP-712 signature...');
    const signature = await wallet.signTypedData(domain, types, authorization);
    console.log(`   Signature: ${signature.substring(0, 20)}...`);

    // Step 4: Build x402 v2 payment payload
    const paymentPayload = {
      x402Version: 2,
      resource: `${process.env.SERVER_URL}/api/data`,
      accepted: paymentRequirements,
      payload: {
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: String(authorization.value),
          validAfter: String(authorization.validAfter),
          validBefore: String(authorization.validBefore),
          nonce: authorization.nonce
        },
        signature
      }
    };

    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    console.log('\nSending payment authorization to server (facilitator flow)...');

    const paidResponse = await fetch(`${process.env.SERVER_URL}/api/data`, {
      headers: { 'X-Payment': paymentHeader }
    });

    if (paidResponse.ok) {
      const data = await paidResponse.json();
      const paymentResponse = paidResponse.headers.get('PAYMENT-RESPONSE');

      let receipt = null;
      if (paymentResponse) {
        receipt = JSON.parse(Buffer.from(paymentResponse, 'base64').toString());
      }

      console.log('\nSUCCESS: Received protected data');
      console.log(data);
      console.log('===============================================');
      if (receipt) {
        console.log('Transaction:', receipt.transaction);
        console.log('Network:', receipt.network);
        console.log('Payer:', receipt.payer);
        console.log('Basescan: https://sepolia.basescan.org/tx/' + receipt.transaction);
      }
      console.log('===============================================\n');
    } else {
      const err = await paidResponse.json();
      console.log('\nERROR:', err.error || err.reason || paidResponse.status);
    }
  }
}

makePayment().catch(console.error);
