import cdk = require('@aws-cdk/core')
import acm = require('@aws-cdk/aws-certificatemanager')
import lambda = require('@aws-cdk/aws-lambda')
import iam = require('@aws-cdk/aws-iam')
import { PUBLIC_URL, API_URL } from './constants'
import { Duration } from '@aws-cdk/core'
import apigateway = require('@aws-cdk/aws-apigateway')

import s3 = require('@aws-cdk/aws-s3')
import cloudfront = require('@aws-cdk/aws-cloudfront')
import s3deploy = require('@aws-cdk/aws-s3-deployment')
import sha256 = require('sha256-file')

export class AmmobinGlobalCdkStack extends cdk.Stack {
  cert: acm.Certificate
  nuxtRerouter: lambda.Function
  nuxtRerouterVersion: lambda.Version

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    this.cert = new acm.Certificate(this, 'RootGlobalCert', {
      domainName: PUBLIC_URL,
      validationMethod: acm.ValidationMethod.DNS,
    })
    new cdk.CfnOutput(this, 'mainCert', { value: this.cert.certificateArn })

    const apiCode = new lambda.AssetCode('dist/edge-lambdas')
    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com')
      ),
      managedPolicies: [
        // need to add this back in so we can write logs
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })
    // https://github.com/bogdal/aws-cdk-website/blob/master/src/SinglePageApplication.ts#L57
    const nuxtRerouter = new lambda.Function(this, 'nuxtRerouter', {
      code: apiCode,
      handler: 'nuxt-rerouter.handler',
      runtime: lambda.Runtime.NODEJS_8_10,
      environment: {},
      timeout: Duration.seconds(3),
      role: lambdaRole,
    }) //.addPermission()

    new cdk.CfnOutput(this, 'nuxtRerouterArn', { value: nuxtRerouter.functionArn })

    // this way it updates version only in case lambda code changes
    // version has to start with a letter
    const version = new lambda.Version(this, 'V' + sha256('edge-lambdas/nuxt-rerouter.ts'), {
      lambda: nuxtRerouter,
    })
    this.nuxtRerouterVersion = version
    // Content bucket
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: 'ammobin-aws-site',
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: '200.html',
      publicReadAccess: false,

      // The default removal policy is RETAIN, which means that cdk destroy will not attempt to delete
      // the new bucket, and it will remain in your account until manually deleted. By setting the policy to
      // DESTROY, cdk destroy will attempt to delete the bucket, but will error if the bucket is not empty.
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production code
    })
    new cdk.CfnOutput(this, 'Bucket', { value: siteBucket.bucketName })

    const distribution = new cloudfront.CloudFrontWebDistribution(this, 'SiteDistribution', {
      aliasConfiguration: {
        // from output of ammobin global cdk stack in us-east-1...
        // todo: make this cleaner + other people can use
        acmCertRef: this.cert.certificateArn,
        names: [PUBLIC_URL],
        securityPolicy: cloudfront.SecurityPolicyProtocol.TLS_V1_1_2016,
      },
      originConfigs: [
        {
          s3OriginSource: {
            s3BucketSource: siteBucket,
            // had to manually override to be sub folder (code build does not output propeerly
          },
          behaviors: [
            {
              lambdaFunctionAssociations: [
                {
                  eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
                  lambdaFunction: version,
                },
              ],
              isDefaultBehavior: true,
              // pathPattern: '_nuxt/*',
            },
          ],
        },
        // route api requests to the api lambda + gateway
        {
          customOriginSource: {
            domainName: API_URL,
          },
          behaviors: [
            {
              isDefaultBehavior: false,
              pathPattern: 'api/*',
              allowedMethods: cloudfront.CloudFrontAllowedMethods.ALL,
            },
          ],
        },
      ],
    })
    // new s3deploy.BucketDeployment(this, 'DeployWithInvalidation', {
    //   sources: [s3deploy.Source.asset('./site-contents')],
    //   destinationBucket: siteBucket,
    //   distribution,
    //   // distributionPaths: ['/*'],
    // })

    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId })

    // the main magic to easily pass the lambda version to stack in another region
    new cdk.CfnOutput(this, 'nuxtRerouterArnWithVersion', {
      value: cdk.Fn.join(':', [nuxtRerouter.functionArn, version.version]),
    })
  }
}
