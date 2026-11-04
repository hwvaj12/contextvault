import { revisionStoreContract } from '../git/revision-contract';
import { setup } from './helpers';
revisionStoreContract(process.env.CV_TEST_S3_PROVIDER === 'localstack' ? 'LocalStack S3' : 'AWS S3', setup);
